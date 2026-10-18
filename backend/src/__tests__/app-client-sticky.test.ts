// Tests for resolveAppClientParams (tg/appClient.ts).
//
// When an account has no explicit app client and the global mode is "random",
// a random client must be picked ONCE and then stay stable for that account --
// reused for auth, jobs and the live client -- rather than changing every call.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { resolveAppClientParams } from "../tg/appClient";
import { getSetting, setSetting } from "../db/repos/settings";
import { useTestDb } from "./helpers/db";
import type { TgAppClient } from "../types";

const CLIENTS: TgAppClient[] = [
  { id: "a", name: "A", deviceModel: "DeviceA", systemVersion: "1", appVersion: "1", langCode: "en", langPack: "", systemLangCode: "en", isDefault: false },
  { id: "b", name: "B", deviceModel: "DeviceB", systemVersion: "2", appVersion: "2", langCode: "en", langPack: "", systemLangCode: "en", isDefault: true },
  { id: "c", name: "C", deviceModel: "DeviceC", systemVersion: "3", appVersion: "3", langCode: "en", langPack: "", systemLangCode: "en", isDefault: false },
];

// Mode, clients and per-account assignments are all settings, so this runs against a real
// database instead of a `:memory:` SQLite handle.
useTestDb();

async function setMode(mode: string) {
  await setSetting("tg_client_mode", mode);
}

async function assignments(): Promise<Record<string, string>> {
  const value = await getSetting("tg_client_assignments");
  return value ? JSON.parse(value) : {};
}

beforeEach(async () => {
  await setSetting("tg_app_clients", JSON.stringify(CLIENTS));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveAppClientParams", () => {
  it("uses the explicitly-set client", async () => {
    await setMode("random");
    const params = await resolveAppClientParams(1, "c");
    expect(params?.deviceModel).toBe("DeviceC");
    // Explicit choice must not create a sticky assignment.
    expect(await assignments()).toEqual({});
  });

  it("uses the default client when mode is not random", async () => {
    await setMode("default");
    const params = await resolveAppClientParams(1, null);
    expect(params?.deviceModel).toBe("DeviceB"); // isDefault
    expect(await assignments()).toEqual({});
  });

  it("picks a random client and persists it for the account", async () => {
    await setMode("random");
    // Force the first pick to index 2 ("c").
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const params = await resolveAppClientParams(7, null);
    expect(params?.deviceModel).toBe("DeviceC");
    expect(await assignments()).toEqual({ "7": "c" });
  });

  it("sticks with the first pick and never re-randomises", async () => {
    await setMode("random");
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // first pick -> "a"
    const first = await resolveAppClientParams(7, null);
    expect(first?.deviceModel).toBe("DeviceA");

    // Even if the RNG would now choose a different client, the account stays on "a".
    rnd.mockReturnValue(0.9);
    const second = await resolveAppClientParams(7, null);
    expect(second?.deviceModel).toBe("DeviceA");
    const third = await resolveAppClientParams(7, null);
    expect(third?.deviceModel).toBe("DeviceA");
    expect(await assignments()).toEqual({ "7": "a" });
  });

  it("assigns independently per account", async () => {
    await setMode("random");
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // "a"
    await resolveAppClientParams(1, null);
    rnd.mockReturnValue(0.9); // "c"
    await resolveAppClientParams(2, null);
    expect(await assignments()).toEqual({ "1": "a", "2": "c" });
  });

  it("re-rolls only if the assigned client no longer exists", async () => {
    await setMode("random");
    // Pre-seed an assignment pointing at a client that isn't in the list.
    await setSetting("tg_client_assignments", JSON.stringify({ "7": "gone" }));
    vi.spyOn(Math, "random").mockReturnValue(0); // re-pick -> "a"
    const params = await resolveAppClientParams(7, null);
    expect(params?.deviceModel).toBe("DeviceA");
    expect(await assignments()).toEqual({ "7": "a" });
  });
});
