// A free CloakBrowser key allows one concurrent session, so the pool has to hand each
// running browser a different key and never the same one twice -- and it must never let a
// raw key back out to the client.
import { describe, it, expect, beforeEach } from "vitest";

import {
  CF_KEYS_SETTING,
  cfLicenseKeys,
  cfLicenseKeysForClient,
  cfLicenseUsage,
  leaseCfLicenseKey,
  maskKey,
  saveCfLicenseKeys,
} from "../jobs/cfLicense";
import { getSetting } from "../db/repos/settings";
import { useTestDb } from "./helpers/db";

// The keys are stored in the settings collection, so these run against a real database.
useTestDb();

beforeEach(async () => {
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
  await saveCfLicenseKeys([]);
});

describe("stored keys", () => {
  it("keeps what was saved and drops entries with no key", async () => {
    await saveCfLicenseKeys([
      { label: "acct-a", key: "cb_aaaaaaaaaaaa" },
      { label: "blank", key: "  " },
    ]);
    expect(await cfLicenseKeys()).toEqual([{ label: "acct-a", key: "cb_aaaaaaaaaaaa" }]);
  });

  it("never sends a raw key to the client", async () => {
    await saveCfLicenseKeys([{ label: "acct-a", key: "cb_aaaaaaaaaaaa" }]);
    const view = await cfLicenseKeysForClient();
    expect(view).toEqual([{ label: "acct-a", masked: maskKey("cb_aaaaaaaaaaaa") }]);
    expect(JSON.stringify(view)).not.toContain("cb_aaaaaaaaaaaa");
  });

  // The client only ever holds masked values, so a save that echoes one back has to keep
  // the stored key rather than replacing it with the mask.
  it("keeps the stored key when the client sends the masked value back", async () => {
    await saveCfLicenseKeys([{ label: "acct-a", key: "cb_aaaaaaaaaaaa" }]);
    await saveCfLicenseKeys([{ label: "renamed", key: maskKey("cb_aaaaaaaaaaaa") }]);
    expect(await cfLicenseKeys()).toEqual([{ label: "renamed", key: "cb_aaaaaaaaaaaa" }]);
  });

  it("drops a duplicate of a key already in the list", async () => {
    await saveCfLicenseKeys([
      { label: "a", key: "cb_aaaaaaaaaaaa" },
      { label: "a again", key: "cb_aaaaaaaaaaaa" },
    ]);
    expect(await cfLicenseKeys()).toHaveLength(1);
  });

  it("stores under the documented settings key", async () => {
    await saveCfLicenseKeys([{ label: "a", key: "cb_aaaaaaaaaaaa" }]);
    expect(await getSetting(CF_KEYS_SETTING)).toContain("cb_aaaaaaaaaaaa");
  });
});

describe("leasing", () => {
  beforeEach(async () => {
    await saveCfLicenseKeys([
      { label: "a", key: "cb_aaaaaaaaaaaa" },
      { label: "b", key: "cb_bbbbbbbbbbbb" },
    ]);
  });

  it("hands two concurrent browsers different keys", async () => {
    const first = await leaseCfLicenseKey();
    const second = await leaseCfLicenseKey();
    expect(first.key).toBeDefined();
    expect(second.key).toBeDefined();
    expect(first.key).not.toBe(second.key);
    expect(await cfLicenseUsage()).toEqual({ total: 2, inUse: 2 });
  });

  // Doubling up would put two sessions on one seat, which the licence server refuses. A
  // caller that will not wait gets no key rather than a seat somebody else is sitting in.
  it("gives no key out once every seat is taken", async () => {
    await leaseCfLicenseKey();
    await leaseCfLicenseKey();
    expect((await leaseCfLicenseKey()).key).toBeUndefined();
  });

  it("offers a key again once its browser has closed", async () => {
    const first = await leaseCfLicenseKey();
    await leaseCfLicenseKey();
    first.release();
    expect((await leaseCfLicenseKey()).key).toBe(first.key);
  });

  // The point of waiting: concurrency follows how many keys the operator has, instead of
  // the launch failing or running the keyed build unlicensed.
  it("hands a waiting launch the seat the moment one is released", async () => {
    const first = await leaseCfLicenseKey();
    await leaseCfLicenseKey();
    const queued = leaseCfLicenseKey(5_000);
    first.release();
    expect((await queued).key).toBe(first.key);
    // still held, by the waiter this time
    expect((await cfLicenseUsage()).inUse).toBe(2);
  });

  it("serves waiters in the order they arrived", async () => {
    const first = await leaseCfLicenseKey();
    const second = await leaseCfLicenseKey();
    const earlier = leaseCfLicenseKey(5_000);
    const later = leaseCfLicenseKey(5_000);
    first.release();
    second.release();
    expect((await earlier).key).toBe(first.key);
    expect((await later).key).toBe(second.key);
  });

  it("gives up with no key when the wait runs out", async () => {
    await leaseCfLicenseKey();
    await leaseCfLicenseKey();
    expect((await leaseCfLicenseKey(20)).key).toBeUndefined();
  });

  it("does not wait when no key is configured at all", async () => {
    await saveCfLicenseKeys([]);
    expect((await leaseCfLicenseKey(5_000)).key).toBeUndefined();
    expect(await cfLicenseUsage()).toEqual({ total: 0, inUse: 0 });
  });

  // Releasing twice would hand the same seat out to two waiters.
  it("ignores a second release of the same lease", async () => {
    const first = await leaseCfLicenseKey();
    first.release();
    first.release();
    expect((await cfLicenseUsage()).inUse).toBe(0);
  });

  it("lets the environment override the stored keys", async () => {
    process.env.CLOAKBROWSER_LICENSE_KEY = "cb_from_env";
    expect((await leaseCfLicenseKey()).key).toBe("cb_from_env");
    // and takes no seat, so it is not exhausted by concurrent jobs
    expect((await leaseCfLicenseKey()).key).toBe("cb_from_env");
  });

  it("frees anything queued when the keys are replaced", async () => {
    await leaseCfLicenseKey();
    await leaseCfLicenseKey();
    const queued = leaseCfLicenseKey(5_000);
    await saveCfLicenseKeys([{ label: "c", key: "cb_cccccccccccc" }]);
    expect((await queued).key).toBeUndefined();
  });
});
