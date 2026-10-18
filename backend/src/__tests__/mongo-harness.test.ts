// The harness itself, and the two things every repository depends on: sequential ids, and
// the cascading deletes MongoDB cannot do for us now that there are no foreign keys.

import { describe, it, expect } from "vitest";

import { dump, insert, useTestDb } from "./helpers/db";
import { col } from "../db/collection";
import { nextId, seedCounterAbove } from "../db/mongo/ids";
import { getDb } from "../db/mongo/client";
import { createAccount, deleteAccount } from "../db/repos/accounts";
import { createJob, deleteJob } from "../db/repos/jobs";
import { runStarted } from "../db/repos/logs";
import type { SettingDoc } from "../db/types";

describe("the test database", () => {
  useTestDb();

  it("starts empty and accepts rows", async () => {
    expect(await dump("tg_accounts")).toEqual([]);
    await insert("tg_accounts", [{ _id: 1, name: "one" }]);
    expect(await dump("tg_accounts")).toHaveLength(1);
  });

  it("forgets everything the previous test wrote", async () => {
    expect(await dump("tg_accounts")).toEqual([]);
  });
});

describe("sequential ids", () => {
  useTestDb();

  it("hands out 1, 2, 3 rather than ObjectIds", async () => {
    const db = getDb();
    expect(await nextId(db, "tg_accounts")).toBe(1);
    expect(await nextId(db, "tg_accounts")).toBe(2);
    expect(await nextId(db, "jobs")).toBe(1); // a separate counter per collection
  });

  it("can be moved past ids that were imported rather than issued", async () => {
    const db = getDb();
    await seedCounterAbove(db, "tg_accounts", 41);
    expect(await nextId(db, "tg_accounts")).toBe(42);
  });
});

describe("cascading deletes", () => {
  useTestDb();

  it("detaches a job from a deleted account instead of dropping the job", async () => {
    const accountId = await createAccount({ name: "acc", phone_number: "+100" } as any);
    const jobId = await createJob({ name: "job", job_type: "checkin", account_id: accountId } as any);

    await deleteAccount(accountId);

    expect(await dump("tg_accounts")).toEqual([]);
    const jobs = await dump<{ _id: number; account_id: number | null }>("jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].account_id).toBeNull();
    expect(jobId).toBeGreaterThan(0);
  });

  it("removes a job's logs with the job", async () => {
    const jobId = await createJob({ name: "job", job_type: "checkin" } as any);
    await runStarted(jobId, { message: "ran" });

    expect(await dump("job_logs")).toHaveLength(1);
    await deleteJob(jobId);
    expect(await dump("job_logs")).toEqual([]);
  });
});

describe("the collection handle", () => {
  useTestDb();

  it("resolves to this file's own database", async () => {
    expect(getDb().databaseName).toBe(process.env.MONGODB_DB);
    // A settings document's _id is the key, a string -- so the collection has to be told,
    // or the driver assumes the ObjectId it would generate itself.
    await col<SettingDoc>("settings").updateOne(
      { _id: "k" },
      { $set: { value: "v" } },
      { upsert: true },
    );
    expect(await dump("settings")).toEqual([{ _id: "k", value: "v" }]);
  });
});
