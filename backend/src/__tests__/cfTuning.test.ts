// The browser timings are stored resolved, so what a user saves is exactly what a job
// runs with -- these guard the folding of stored values over the shipped defaults.

import { describe, it, expect, beforeEach } from "vitest";

import {
  CF_TUNING_DEFAULTS,
  CF_TUNING_FIELDS,
  CF_TUNING_KEY,
  CF_TUNING_LIMITS,
  cfTuning,
  invalidateCfTuning,
  resolveCfTuning,
} from "../jobs/cfTuning";
import { setSetting } from "../db/repos/settings";
import { useTestDb } from "./helpers/db";

// The timings live in the settings collection, so these go through a real database rather
// than a stubbed `prepare`. Every test starts empty: a stored value is one this file put
// there, which is what makes "falls back to the defaults" mean anything.
useTestDb();

beforeEach(() => {
  invalidateCfTuning();
});

describe("resolveCfTuning", () => {
  it("falls back to the shipped defaults when nothing is stored", () => {
    expect(resolveCfTuning(undefined)).toEqual(CF_TUNING_DEFAULTS);
    expect(resolveCfTuning(null)).toEqual(CF_TUNING_DEFAULTS);
    expect(resolveCfTuning("not an object")).toEqual(CF_TUNING_DEFAULTS);
    expect(resolveCfTuning({})).toEqual(CF_TUNING_DEFAULTS);
  });

  it("keeps a field's default when its stored value is unusable", () => {
    const got = resolveCfTuning({ navTimeoutMs: "abc", pollMs: null, settleMs: NaN });
    expect(got.navTimeoutMs).toBe(CF_TUNING_DEFAULTS.navTimeoutMs);
    expect(got.pollMs).toBe(CF_TUNING_DEFAULTS.pollMs);
    expect(got.settleMs).toBe(CF_TUNING_DEFAULTS.settleMs);
  });

  it("takes a numeric string, as a form field sends it", () => {
    expect(resolveCfTuning({ budgetMs: "600000" }).budgetMs).toBe(600_000);
  });

  it("holds every field inside its range", () => {
    for (const field of CF_TUNING_FIELDS) {
      const { min, max } = CF_TUNING_LIMITS[field];
      expect(resolveCfTuning({ [field]: max * 10 })[field]).toBe(max);
      expect(resolveCfTuning({ [field]: -1 })[field]).toBe(min);
    }
  });

  it("leaves the other fields alone when one is set", () => {
    const got = resolveCfTuning({ pollMs: 2_000 });
    expect(got.pollMs).toBe(2_000);
    expect(got.navTimeoutMs).toBe(CF_TUNING_DEFAULTS.navTimeoutMs);
  });
});

describe("cfTuning", () => {
  it("reads what is stored, and picks up a change once invalidated", async () => {
    expect((await cfTuning()).budgetMs).toBe(CF_TUNING_DEFAULTS.budgetMs);

    await setSetting(CF_TUNING_KEY, JSON.stringify({ budgetMs: 90_000 }));
    expect((await cfTuning()).budgetMs).toBe(CF_TUNING_DEFAULTS.budgetMs); // still cached
    invalidateCfTuning();
    expect((await cfTuning()).budgetMs).toBe(90_000);
  });

  it("survives a corrupt setting", async () => {
    await setSetting(CF_TUNING_KEY, "{ not json");
    invalidateCfTuning();
    expect(await cfTuning()).toEqual(CF_TUNING_DEFAULTS);
  });

  it("describes every field it exposes", () => {
    for (const field of CF_TUNING_FIELDS) {
      expect(CF_TUNING_LIMITS[field]).toBeDefined();
      expect(CF_TUNING_LIMITS[field].min).toBeLessThanOrEqual(CF_TUNING_DEFAULTS[field]);
      expect(CF_TUNING_LIMITS[field].max).toBeGreaterThanOrEqual(CF_TUNING_DEFAULTS[field]);
    }
  });
});

// The point of the setting is that the solver reads it, so check one value all the way
// through: the blank-page threshold decides a Mini App verdict.
describe("the solver reads the configured values", () => {
  it("changes a verdict when the blank-page length is changed", async () => {
    const { miniAppVerdict } = await import("../jobs/cloudflare");
    const shortPage = { challenged: false, solved: true, text: "abc" };

    await setSetting(CF_TUNING_KEY, JSON.stringify({ blankTextLen: 0 }));
    invalidateCfTuning();
    expect((await miniAppVerdict({ ...shortPage })).ok).toBe(true);

    await setSetting(CF_TUNING_KEY, JSON.stringify({ blankTextLen: 5_000 }));
    invalidateCfTuning();
    const strict = await miniAppVerdict({ ...shortPage });
    expect(strict.ok).toBe(false);
    expect(strict.reason).toMatch(/blank/);
  });
});
