// A solver browser that cannot start says nothing about the exit it would have gone out
// through. Before this was separated out, the failure counted as a refusal, so one broken
// browser burned the whole proxy pool and the job reported it as Cloudflare turning every
// exit away -- which sent the operator hunting for a proxy problem that was not there.

// The solver reads its timings out of the settings collection, so it needs a database even
// though the browser it would launch is mocked out.
useTestDb();

const launchCfBrowser = vi.fn();
vi.mock("../jobs/cfBrowser", () => ({
  launchCfBrowser: (...args: unknown[]) => launchCfBrowser(...args),
  isChromiumInstalled: () => true,
  chromiumExecutable: () => "/tmp/chrome",
  applyCfFontEnv: () => {},
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setSetting } from "../db/repos/settings";
import { useTestDb } from "./helpers/db";
import {
  cfNoCandidatesMessage,
  cfNoteFailure,
  cfRefusedFor,
  loadCheckinUrl,
  newCfRunState,
} from "../jobs/cloudflare";

const CANDIDATES = [
  { id: "p1", label: "Proxy One", url: "http://1.1.1.1:8080" },
  { id: "p2", label: "Proxy Two", url: "http://2.2.2.2:8080" },
  { id: "p3", label: "Proxy Three", url: "http://3.3.3.3:8080" },
];

// What the keyed build leaves behind when it quits during startup
const SIGTRAP_FAILURE =
  "browserType.launchPersistentContext: Target page, context or browser has been closed " +
  "Browser logs: <launching> /app/data/cloakbrowser/chromium-150.0.7871.114-pro/chrome " +
  "--disable-field-trial-config ... <launched> pid=583 ... handshake failed; returned -1, " +
  "SSL error code 1, net_error -3 <gracefully close start> - [pid=583] <process did exit: " +
  "exitCode=null, signal=SIGTRAP>";

// A stand-in for the solver browser. loadCheckinUrl asks the page many different questions
// through evaluate(); this answers them by what the evaluated source is looking for, which
// is enough to walk a page that loads cleanly, raises no challenge, and does not have the
// control the caller named.
function fakeBrowser(opts: { text: string }) {
  const page: any = {
    on: () => {},
    addInitScript: async () => {},
    goto: async () => {},
    url: () => "https://example.com/app",
    title: async () => "The App",
    screenshot: async () => Buffer.from("x"),
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    mouse: { move: async () => {}, click: async () => {}, wheel: async () => {} },
    evaluate: async (fn: unknown) => {
      const src = String(fn);
      // The visible text of the page, asked for at several points
      if (src.includes("innerText")) return opts.text;
      // Every challenge probe: none of them are on this page
      return null;
    },
  };
  return { context: {}, page, key: "direct", close: async () => {} };
}

beforeEach(async () => {
  // The solver's waits are configurable, so the test does not have to sit through them
  await setSetting(
    "cf_tuning",
    JSON.stringify({
      budgetMs: 30_000,
      appReadyTimeoutMs: 2_000,
      challengeTimeoutMs: 5_000,
      postClickChallengeMs: 0,
      confirmTimeoutMs: 0,
      settleMs: 0,
      inAppStepMs: 0,
      inAppSettleMs: 0,
      pollMs: 200,
      readyPollMs: 100,
      navTimeoutMs: 5_000,
      protocolTimeoutMs: 5_000,
    }),
  );
  launchCfBrowser.mockReset();
});

describe("a solver browser that cannot start", () => {
  it("refuses no proxy and tries only one exit", async () => {
    launchCfBrowser.mockRejectedValue(new Error(SIGTRAP_FAILURE));

    const res = await loadCheckinUrl("https://example.com/app", undefined, {
      proxyCandidates: CANDIDATES,
      maxWaitMs: 30_000,
    });

    expect(res.ok).toBe(false);
    expect(res.browserFailed).toBe(true);
    // The pool is untouched: nothing here was the exits' doing
    expect(res.refusedProxyIds).toEqual([]);
    expect(res.attempts).toBe(1);
    expect(launchCfBrowser).toHaveBeenCalledTimes(1);
    expect(res.trace?.join(" ")).toContain("could not start");
  });

  it("leads with the licence explanation rather than the Chromium log", async () => {
    launchCfBrowser.mockRejectedValue(new Error(SIGTRAP_FAILURE));

    const res = await loadCheckinUrl("https://example.com/app", undefined, {
      proxyCandidates: CANDIDATES,
      maxWaitMs: 30_000,
    });

    expect(res.reason).toMatch(/licensed browser build quit during startup/);
    expect(res.reason).toMatch(/one browser at a time/);
  });

  it("names a missing binary as such", async () => {
    launchCfBrowser.mockRejectedValue(new Error("Failed to launch: ENOENT /tmp/chrome"));

    const res = await loadCheckinUrl("https://example.com/app", undefined, {
      proxyCandidates: CANDIDATES,
      maxWaitMs: 30_000,
    });

    expect(res.reason).toMatch(/binary could not be started/);
    expect(res.refusedProxyIds).toEqual([]);
  });
});

// A failure the exit had no hand in must not consume the proxy pool. It used to: the app
// simply not having the control being looked for marked the exit refused, and the action's
// own retry then had nothing left to offer and reported "every available proxy was already
// refused" -- a Cloudflare answer to a question Cloudflare was never asked.
describe("a failure inside the app", () => {
  it("refuses no exit, so a retry still has the pool to work with", async () => {
    // A page that loads, is never challenged, and whose in-app step finds nothing
    launchCfBrowser.mockResolvedValue(fakeBrowser({ text: "每日签到\n积分 120" }));

    const res = await loadCheckinUrl("https://example.com/app", undefined, {
      miniApp: true,
      inAppClicks: ["Join giveaway"],
      proxyCandidates: CANDIDATES,
      maxWaitMs: 30_000,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/Join giveaway/);
    expect(res.refusedProxyIds).toEqual([]);
    // And it stopped at the first exit rather than replaying the same miss through the pool
    expect(res.attempts).toBe(1);
  });
});

describe("the message when no exit is left to try", () => {
  it("says what actually emptied the pool, not just a count", () => {
    const run = newCfRunState();
    cfRefusedFor(run, "app.example.com").add("p1");
    cfNoteFailure(run, "app.example.com", 'Could not pass the Cloudflare "I am not a bot" challenge');

    const msg = cfNoCandidatesMessage(run, "app.example.com");
    expect(msg).toContain("All 1 available proxy");
    expect(msg).toContain("app.example.com");
    expect(msg).toMatch(/I am not a bot/);
  });

  it("does not claim a refusal when nothing was refused", () => {
    const run = newCfRunState();
    cfNoteFailure(run, "app.example.com", "the solver browser could not be started");

    const msg = cfNoCandidatesMessage(run, "app.example.com");
    expect(msg).not.toMatch(/refused|already been tried/);
    expect(msg).toMatch(/solver browser could not be started/);
  });

  it("counts plurals and copes with an unknown host", () => {
    const run = newCfRunState();
    const refused = cfRefusedFor(run, "");
    refused.add("p1");
    refused.add("p2");
    expect(cfNoCandidatesMessage(run, "")).toContain("All 2 available proxies");
    expect(cfNoCandidatesMessage(run, "")).toContain("the target site");
  });
});
