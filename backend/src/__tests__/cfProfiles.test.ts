// Browser profiles are the one piece of state a run carries over from the last one, so
// clearing them is the first thing to try when a browser starts failing for no reason that
// changed elsewhere. One profile that cannot be removed must not stop the others going.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { cfProfileCount, clearCfProfiles } from "../jobs/cfBrowser";

const root = mkdtempSync(path.join(os.tmpdir(), "cfprofiles-"));
const profiles = path.join(root, "cf-profiles");

beforeEach(() => {
  // dataDir() is read from DB_PATH on every call, so each test can point it somewhere new
  process.env.DB_PATH = path.join(root, "bemby.db");
  rmSync(profiles, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

function makeProfile(name: string) {
  const dir = path.join(profiles, name);
  mkdirSync(path.join(dir, "Default"), { recursive: true });
  writeFileSync(path.join(dir, ".bemby-last-used"), "");
  // What a browser that was killed leaves behind
  writeFileSync(path.join(dir, "SingletonLock"), "");
  return dir;
}

describe("clearCfProfiles", () => {
  it("removes every profile and says how many went", () => {
    makeProfile("direct");
    makeProfile("a1b2c3");
    makeProfile("d4e5f6");
    expect(cfProfileCount()).toBe(3);

    expect(clearCfProfiles()).toEqual({ removed: 3 });
    expect(cfProfileCount()).toBe(0);
    expect(existsSync(path.join(profiles, "direct"))).toBe(false);
  });

  it("takes the stale lock files with them", () => {
    const dir = makeProfile("direct");
    expect(existsSync(path.join(dir, "SingletonLock"))).toBe(true);
    clearCfProfiles();
    expect(existsSync(dir)).toBe(false);
  });

  it("is nothing to clear rather than a failure when none exist", () => {
    expect(clearCfProfiles()).toEqual({ removed: 0 });
    expect(cfProfileCount()).toBe(0);
  });

  it("counts nothing when the directory has never been made", () => {
    process.env.DB_PATH = path.join(root, "nowhere", "bemby.db");
    expect(cfProfileCount()).toBe(0);
    expect(clearCfProfiles()).toEqual({ removed: 0 });
  });
});
