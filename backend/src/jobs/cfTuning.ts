import { getSetting } from "../db/repos/settings";

// Every number the Cloudflare/Mini App browser runs on. They started as constants in the
// solver; sites differ enough (a slow app, a proxy with high latency, a captcha that takes
// its time) that they are worth tuning without a rebuild. Anything unset, unparsable or
// out of range falls back to the value the solver shipped with.

export const CF_TUNING_KEY = "cf_tuning";

export type CfTuning = {
  /** Browser budget for one action when it names none, across every proxy tried. */
  budgetMs: number;
  /** Least budget left worth starting another exit with. */
  minAttemptMs: number;
  /** Least budget left worth launching the browser again for a retry of the action. */
  minActionMs: number;
  /** Page load timeout. */
  navTimeoutMs: number;
  /** How long to let a Mini App boot before judging the page. */
  appReadyTimeoutMs: number;
  /** How long to work a challenge that is on the page. */
  challengeTimeoutMs: number;
  /** How long to keep looking for a verification raised by the checkin press. */
  postClickChallengeMs: number;
  /** How long to wait for a site to confirm the outcome after a widget is solved. */
  confirmTimeoutMs: number;
  /** Pause after a challenge clears, before the page is read. */
  settleMs: number;
  /**
   * Pause between closing a browser and launching the next one on the same licence key.
   * A key is one session at a time and the service needs a moment to release the old one.
   */
  relaunchSettleMs: number;
  /** Pause between in-app steps. */
  inAppStepMs: number;
  /** Pause after the last in-app step, for its request to round-trip. */
  inAppSettleMs: number;
  /** Interval between checks while working a challenge. */
  pollMs: number;
  /** Interval between checks while an app is still booting. */
  readyPollMs: number;
  /** Ceiling for a single browser (CDP) call. */
  protocolTimeoutMs: number;
  /** Exits offered per attempt for a plain Cloudflare page. */
  proxyCandidates: number;
  /** Ceiling on exits offered when an action tries the whole pool. */
  maxPoolCandidates: number;
  /** Browser profiles kept in the data dir, most recently used first. */
  maxProfiles: number;
  /** A page with less visible text than this counts as having rendered nothing. */
  blankTextLen: number;
  /** Browser window width in pixels. 0 leaves the size to Chromium. */
  windowWidth: number;
  /**
   * Browser window height in pixels. 0 leaves the size to Chromium. The page has no
   * emulated viewport, so the window is the viewport: a taller one puts more of a long
   * Mini App page on screen, which is all a screenshot and `{aiBtn}` can see.
   */
  windowHeight: number;
};

/** The values the solver shipped with. */
export const CF_TUNING_DEFAULTS: CfTuning = {
  budgetMs: 300_000,
  minAttemptMs: 10_000,
  minActionMs: 15_000,
  navTimeoutMs: 45_000,
  appReadyTimeoutMs: 25_000,
  challengeTimeoutMs: 45_000,
  postClickChallengeMs: 20_000,
  confirmTimeoutMs: 20_000,
  settleMs: 1_500,
  relaunchSettleMs: 3_000,
  inAppStepMs: 1_200,
  inAppSettleMs: 4_000,
  pollMs: 1_000,
  readyPollMs: 500,
  protocolTimeoutMs: 30_000,
  proxyCandidates: 8,
  maxPoolCandidates: 200,
  maxProfiles: 12,
  blankTextLen: 10,
  windowWidth: 0,
  windowHeight: 0,
};

/** Range each value is held to, so a typo cannot wedge a job for an hour. */
export const CF_TUNING_LIMITS: Record<keyof CfTuning, { min: number; max: number }> = {
  budgetMs: { min: 30_000, max: 3_600_000 },
  minAttemptMs: { min: 2_000, max: 120_000 },
  minActionMs: { min: 2_000, max: 120_000 },
  navTimeoutMs: { min: 5_000, max: 180_000 },
  appReadyTimeoutMs: { min: 2_000, max: 180_000 },
  challengeTimeoutMs: { min: 5_000, max: 300_000 },
  postClickChallengeMs: { min: 0, max: 180_000 },
  confirmTimeoutMs: { min: 0, max: 180_000 },
  settleMs: { min: 0, max: 60_000 },
  relaunchSettleMs: { min: 0, max: 60_000 },
  inAppStepMs: { min: 0, max: 60_000 },
  inAppSettleMs: { min: 0, max: 60_000 },
  pollMs: { min: 200, max: 10_000 },
  readyPollMs: { min: 100, max: 10_000 },
  protocolTimeoutMs: { min: 5_000, max: 300_000 },
  proxyCandidates: { min: 1, max: 200 },
  maxPoolCandidates: { min: 1, max: 500 },
  maxProfiles: { min: 0, max: 200 },
  blankTextLen: { min: 0, max: 5_000 },
  windowWidth: { min: 0, max: 3_840 },
  windowHeight: { min: 0, max: 4_320 },
};

export const CF_TUNING_FIELDS = Object.keys(CF_TUNING_DEFAULTS) as Array<keyof CfTuning>;

/**
 * Folds stored values over the defaults, keeping each inside its range. Used both when
 * reading for a job and when saving from the client, so a value is stored exactly as it
 * will be applied.
 */
export function resolveCfTuning(stored: unknown): CfTuning {
  const out = { ...CF_TUNING_DEFAULTS };
  if (!stored || typeof stored !== "object") return out;
  for (const field of CF_TUNING_FIELDS) {
    const raw = (stored as Record<string, unknown>)[field];
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    const { min, max } = CF_TUNING_LIMITS[field];
    out[field] = Math.round(Math.min(max, Math.max(min, n)));
  }
  return out;
}

// Read on every poll of every challenge otherwise; cached, and dropped when the setting is
// written so a change applies to the next job without a restart.
let cached: CfTuning | undefined;

export function invalidateCfTuning(): void {
  cached = undefined;
}

/** The numbers in force right now. */
export async function cfTuning(): Promise<CfTuning> {
  if (cached) return cached;
  let stored: unknown;
  try {
    const value = await getSetting(CF_TUNING_KEY);
    if (value) stored = JSON.parse(value);
  } catch {
    /* fall back to defaults */
  }
  cached = resolveCfTuning(stored);
  return cached;
}
