import type { BrowserContext, Page } from "playwright-core";
import { cfTuning } from "./cfTuning";
import {
  chromiumExecutable,
  chromiumVersion,
  launchCfBrowser,
  type LaunchedBrowser,
} from "./cfBrowser";
import {
  cfExitGeo,
  rememberCfExitGeo,
  type CfExitGeo,
  type ProxyCandidate,
} from "../tg/proxyProviders";
import type { WebStep, WebStepLog } from "../types";

// Completes a checkin that hands back a URL behind Cloudflare's "I am not a bot"
// (managed challenge / Turnstile). CloakBrowser -- a Chromium whose fingerprint is patched
// at source rather than papered over from JavaScript -- loads the URL and works whatever
// challenge is in the way; because Bemby runs on the user's own host, the browser exits
// from the same IP (and proxy, if set) as expected, so simply loading the page registers
// the checkin server-side.
//
// The browser itself, its profiles and its fonts live in the data dir and are installed on
// demand: see cfBrowser.ts and cfFonts.ts, whose API is re-exported here so callers have
// one Cloudflare module to talk to.

export {
  chromiumExecutable,
  chromiumVersion,
  cloakCacheDir,
  installCfChromium,
  installedBuildTier,
  isChromiumInstalled,
  keyedBuildPending,
} from "./cfBrowser";
export {
  CF_FONTS,
  areCfFontsInstalled,
  cfFontsRoot,
  cfFontsStatus,
  installCfFonts,
} from "./cfFonts";


// Primary timezone and locale per country, for aligning the browser with its exit IP: a
// residential address in Japan reporting UTC and en-US is a cheap signal to check.
// Countries not listed are left alone rather than guessed at.
const COUNTRY_LOCALE: Record<string, { tz: string; lang: string }> = {
  AE: { tz: "Asia/Dubai", lang: "ar-AE" },
  AR: { tz: "America/Argentina/Buenos_Aires", lang: "es-AR" },
  AT: { tz: "Europe/Vienna", lang: "de-AT" },
  AU: { tz: "Australia/Sydney", lang: "en-AU" },
  BE: { tz: "Europe/Brussels", lang: "nl-BE" },
  BR: { tz: "America/Sao_Paulo", lang: "pt-BR" },
  CA: { tz: "America/Toronto", lang: "en-CA" },
  CH: { tz: "Europe/Zurich", lang: "de-CH" },
  CL: { tz: "America/Santiago", lang: "es-CL" },
  CN: { tz: "Asia/Shanghai", lang: "zh-CN" },
  CZ: { tz: "Europe/Prague", lang: "cs-CZ" },
  DE: { tz: "Europe/Berlin", lang: "de-DE" },
  DK: { tz: "Europe/Copenhagen", lang: "da-DK" },
  EE: { tz: "Europe/Tallinn", lang: "et-EE" },
  ES: { tz: "Europe/Madrid", lang: "es-ES" },
  FI: { tz: "Europe/Helsinki", lang: "fi-FI" },
  FR: { tz: "Europe/Paris", lang: "fr-FR" },
  GB: { tz: "Europe/London", lang: "en-GB" },
  HK: { tz: "Asia/Hong_Kong", lang: "zh-HK" },
  HU: { tz: "Europe/Budapest", lang: "hu-HU" },
  ID: { tz: "Asia/Jakarta", lang: "id-ID" },
  IE: { tz: "Europe/Dublin", lang: "en-IE" },
  IL: { tz: "Asia/Jerusalem", lang: "he-IL" },
  IN: { tz: "Asia/Kolkata", lang: "en-IN" },
  IT: { tz: "Europe/Rome", lang: "it-IT" },
  JP: { tz: "Asia/Tokyo", lang: "ja-JP" },
  KR: { tz: "Asia/Seoul", lang: "ko-KR" },
  MX: { tz: "America/Mexico_City", lang: "es-MX" },
  MY: { tz: "Asia/Kuala_Lumpur", lang: "ms-MY" },
  NL: { tz: "Europe/Amsterdam", lang: "nl-NL" },
  NO: { tz: "Europe/Oslo", lang: "nb-NO" },
  NZ: { tz: "Pacific/Auckland", lang: "en-NZ" },
  PH: { tz: "Asia/Manila", lang: "en-PH" },
  PL: { tz: "Europe/Warsaw", lang: "pl-PL" },
  PT: { tz: "Europe/Lisbon", lang: "pt-PT" },
  RO: { tz: "Europe/Bucharest", lang: "ro-RO" },
  RU: { tz: "Europe/Moscow", lang: "ru-RU" },
  SE: { tz: "Europe/Stockholm", lang: "sv-SE" },
  SG: { tz: "Asia/Singapore", lang: "en-SG" },
  TH: { tz: "Asia/Bangkok", lang: "th-TH" },
  TR: { tz: "Europe/Istanbul", lang: "tr-TR" },
  TW: { tz: "Asia/Taipei", lang: "zh-TW" },
  UA: { tz: "Europe/Kyiv", lang: "uk-UA" },
  US: { tz: "America/New_York", lang: "en-US" },
  VN: { tz: "Asia/Ho_Chi_Minh", lang: "vi-VN" },
  ZA: { tz: "Africa/Johannesburg", lang: "en-ZA" },
};

/** Cloudflare's own trace endpoint, which reports the country it sees the request from. */
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

export type CheckinPageResult = {
  /** Reached the destination with no Cloudflare interstitial remaining. */
  ok: boolean;
  /** A Cloudflare challenge was shown at some point. */
  challenged: boolean;
  /** Final page's visible text, for success/fail keyword matching. */
  text: string;
  /** Host of the final URL (kept for logs; full URL is sensitive). */
  finalHost: string;
  /** Label of the checkin control pressed inside a Mini App page, if any. */
  inAppAction?: string;
  /** Id of the proxy the accepted (or last) attempt went through. */
  proxyId?: string;
  /** Human-readable name of that proxy, for the job log. */
  proxyLabel?: string;
  /** How many exits were tried. */
  attempts?: number;
  /**
   * Exits that were used and did not get through. The accepted one is left out, so it
   * stays available, while a retry skips the ones already known to be refused.
   */
  refusedProxyIds?: string[];
  /**
   * The failure is about this exit -- a refused challenge, a page that never loaded -- so
   * another is worth trying. False for a failure inside the app, which every exit meets
   * alike: rotating through the pool then only wastes the budget.
   */
  exitRelated?: boolean;
  /**
   * The browser never started, so the attempt says nothing about the exit at all: the URL
   * was never requested through it. Such an attempt must not count as a refusal, or a
   * browser that cannot start burns the whole proxy pool and reports it as Cloudflare
   * turning every exit away.
   */
  browserFailed?: boolean;
  /** Which browser build ran: the licensed one, or the unlicensed fallback. */
  browserTier?: "keyed" | "free";
  /** Why the attempt is not ok, in plain words, for the job log. */
  reason?: string;
  /** Navigation/renderer trouble seen while loading (page crash, failed request). */
  navError?: string;
  /** Title of the final page: tells a real app apart from a blank or crashed tab. */
  pageTitle?: string;
  /** data: URI screenshot of the final page, so a headless-only failure is visible. */
  screenshot?: string;
  /** One line per exit tried, for the job log. */
  trace?: string[];
  /** One entry per `open_url` sub-step run on the page, with its screenshot. */
  webSteps?: WebStepLog[];
};

/**
 * Browser state belonging to one job run rather than one attempt. A retry that offered
 * the same refused exits again would just replay the same refusals, so the exits are
 * remembered per host across every attempt of the run, and a budget started by an action
 * keeps running for its retries instead of restarting with each one.
 */
export type CfRunState = {
  /** Exits already refused, keyed by host. The accepted one is never in here. */
  refused: Map<string, Set<string>>;
  /** Deadlines the caller has started, keyed however the caller likes. */
  deadlines: Map<string, number>;
  /**
   * Why the last attempt on a host did not get through, kept so that running out of exits
   * can be reported with the failure that actually emptied the pool rather than as a bare
   * count -- "every proxy refused" says nothing about what went wrong.
   */
  lastFailure: Map<string, string>;
};

export function newCfRunState(): CfRunState {
  return { refused: new Map(), deadlines: new Map(), lastFailure: new Map() };
}

/**
 * The message for an action that has no exit left to try. What emptied the pool decides
 * how it reads: exits genuinely turned away by the site is the case the pool exists for,
 * while anything else -- a browser that would not start, an app that never had the control
 * being looked for -- is reported as itself, since no proxy was ever the problem.
 */
export function cfNoCandidatesMessage(state: CfRunState, host: string): string {
  const where = host || "the target site";
  const count = cfRefusedFor(state, host).size;
  const why = state.lastFailure.get(host || "*");
  if (!count) {
    return why
      ? `No proxy was available to try for ${where}. The attempt before it failed with: ${why}`
      : `No proxy was available to try for ${where}`;
  }
  return (
    `All ${count} available prox${count === 1 ? "y" : "ies"} have already been tried for ${where} in this run` +
    (why ? `, and the last one failed with: ${why}` : "")
  );
}

/** Notes why an attempt on `host` failed, for the message above. */
export function cfNoteFailure(state: CfRunState, host: string, reason?: string): void {
  if (reason) state.lastFailure.set(host || "*", reason);
}

/** The refused-exit set for `host`, created on first use. */
export function cfRefusedFor(state: CfRunState, host: string): Set<string> {
  const key = host || "*";
  let set = state.refused.get(key);
  if (!set) {
    set = new Set();
    state.refused.set(key, set);
  }
  return set;
}

export type LoadOptions = {
  /**
   * The URL is a signed Telegram Mini App URL: stub the webview bridge the app
   * expects, and press its checkin control once the page is up.
   */
  miniApp?: boolean;
  /**
   * Steps to run inside the Mini App, in order. Each entry is the visible text of a
   * control to press, or a placeholder: `{input}` solves an arithmetic captcha locally,
   * `{aiInput}` hands the question to `solveQuestion`, and `scroll(x, y)` moves the page
   * so a control below the fold can be reached. Empty or omitted falls back to a
   * checkin-worded control.
   */
  inAppClicks?: string[];
  /** Answers a question read off the app (used by the `{aiInput}` step). */
  solveQuestion?: (question: string) => Promise<string>;
  /**
   * Exits to try, in order, when a challenge is refused. Cloudflare accepts some IPs and
   * not others, so a single proxy is often not enough.
   */
  proxyCandidates?: ProxyCandidate[];
  /** Re-mints the URL between attempts (signed Mini App init data ages). */
  refreshUrl?: () => Promise<string>;
  /**
   * Budget for the whole load, across every exit tried. Each internal wait is
   * clamped to what is left of it, so the step cannot run on indefinitely.
   * Defaults to the budget configured in Settings.
   */
  maxWaitMs?: number;
  /** Keep a screenshot of the final page on the result (diagnostics). */
  screenshot?: boolean;
  /**
   * Sub-steps to run against a plain web page once it is up (the `open_url` action).
   * Unlike `inAppClicks` these are typed rather than text, and each one is captured.
   */
  webSteps?: WebStep[];
  /** Hands a screenshot to the vision model, for the `ai_web_*` sub-steps. */
  aiLocate?: (image: string, prompt: string) => Promise<string>;
};

// Every timing and limit the browser side runs on lives in cfTuning, so it can be
// adjusted in Settings; the values there default to what this solver shipped with.
/**
 * Decides whether a Mini App pass actually did anything. A page that rendered nothing,
 * or one where the step the caller asked for was never carried out, is a failure even
 * though no challenge stood in the way -- reporting it as success logs a checkin that
 * never happened.
 */
export async function miniAppVerdict(state: {
  /** A Cloudflare challenge was seen (and, per `solved`, how it went). */
  challenged: boolean;
  /** Verdict so far: the challenge cleared, or there was none. */
  solved: boolean;
  /** Visible text of the final page. */
  text: string;
  /** In-app steps that were carried out, if any. */
  inAppAction?: string;
  /**
   * Whether those steps actually acted on the app rather than only waiting or scrolling
   * into position. Omitted, any trace counts, which is how callers without the distinction
   * have always behaved.
   */
  inAppActed?: boolean;
  /** Why the in-app steps stopped short, if they did. */
  inAppFailure?: string;
  /** Navigation or renderer trouble seen on the way. */
  navError?: string;
  /** Visible text before the in-app steps ran, to tell a live prompt from page furniture. */
  priorText?: string;
  /** Overrides the configured "a page this short rendered nothing" length. */
  blankTextLen?: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const { challenged, solved, text, inAppAction, inAppFailure, navError, priorText } = state;
  const blankLen = state.blankTextLen ?? (await cfTuning()).blankTextLen;
  // A trace of nothing but waits and scrolls is not evidence the app was reached
  const acted = state.inAppActed ?? !!inAppAction;

  if (!challenged && text.trim().length < blankLen && !acted) {
    return {
      ok: false,
      reason: navError
        ? `the app page never rendered (${navError})`
        : "the app page came up blank -- the browser reached no readable content",
    };
  }
  if (solved && inAppFailure) return { ok: false, reason: inAppFailure };
  // The app's own wording wins over our reading of the page: if it is still asking to be
  // verified, the checkin did not go through, whatever the challenge detection saw. It has
  // to be a live prompt though -- a verify portal headed "Complete the verification" says
  // that whatever the outcome, and vetoing on it fails every exit in the pool. Wording that
  // was already there before the steps ran only counts when nothing else on the page moved.
  if (solved && VERIFY_REQUIRED_RE.test(text) && isLivePrompt(text, priorText)) {
    return {
      ok: false,
      reason:
        "the app is still asking for a human verification, so the checkin did not go " +
        "through -- add the verification step to the action (its control, or css:...)",
    };
  }
  if (!solved) {
    return {
      ok: false,
      reason: challenged
        ? 'Could not pass the Cloudflare "I am not a bot" challenge'
        : (navError ?? "the app page could not be loaded"),
    };
  }
  return { ok: true };
}

/**
 * Whether a verify-required prompt is the page answering what we just did, rather than
 * standing text. New wording is always live. Wording that was already there is only live
 * if the page is otherwise unchanged, which means the steps achieved nothing.
 */
function isLivePrompt(text: string, priorText?: string): boolean {
  if (priorText == null) return true;
  if (!VERIFY_REQUIRED_RE.test(priorText)) return true;
  return text.trim() === priorText.trim();
}

/**
 * The fallback wording for a browser step that failed without saying why. Only a page that
 * actually met a challenge is described as one: naming Cloudflare on a step where no
 * challenge ever appeared sends the reader after the wrong thing entirely.
 */
export function cfFailureFallback(challenged: boolean, miniApp = false): string {
  if (challenged) return 'Could not pass the Cloudflare "I am not a bot" challenge';
  return miniApp
    ? "The Mini App did not get through, and no challenge was involved -- see the step's page text and screenshot"
    : "The page did not get through, and no challenge was involved";
}

/** Why a plain page load did not get through, in plain words, for the job log. */
function challengeRefused(challenged: boolean, navError?: string): string {
  if (challenged) return 'Could not pass the Cloudflare "I am not a bot" challenge';
  return navError ?? "the page could not be loaded";
}

/** Millis left before `deadline`, never negative. */
function msLeft(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/** `ms`, cut down to what is left of the budget. */
function capped(ms: number, deadline: number): number {
  return Math.min(ms, msLeft(deadline));
}

/** Sleeps `ms`, or until the budget runs out. */
function sleep(ms: number, deadline?: number): Promise<void> {
  const wait = deadline ? capped(ms, deadline) : ms;
  return new Promise((r) => setTimeout(r, Math.max(0, wait)));
}

/**
 * Asks Cloudflare where this exit comes out, so the next launch can carry the matching
 * clock and language. Looked up once per exit and remembered: a proxy's country does not
 * move, and the lookup costs a page load.
 *
 * Nothing is emulated over CDP here -- that is detectable in itself. What is learnt is
 * handed to the browser as launch flags, which is why the caller relaunches once when an
 * exit turns out to be somewhere new.
 */
async function probeExitGeo(
  page: Page,
  key: string,
  deadline: number,
): Promise<CfExitGeo | undefined> {
  try {
    await page.goto(TRACE_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(5_000, capped(15_000, deadline)),
    });
    const body = await page.evaluate(() => document.body?.innerText ?? "");
    const loc = /(?:^|\n)loc=([A-Z]{2})/.exec(body)?.[1];
    if (!loc) return undefined;
    const geo: CfExitGeo = { loc, ...(COUNTRY_LOCALE[loc] ?? {}) };
    rememberCfExitGeo(key, geo);
    console.log(
      `[cloudflare] exit ${key} comes out in ${loc}` +
        (geo.tz ? ` -- using ${geo.tz} / ${geo.lang}` : " -- no locale mapped"),
    );
    return geo;
  } catch (err: any) {
    console.warn(`[cloudflare] exit lookup failed: ${err?.message ?? err}`);
    return undefined;
  }
}

/**
 * A browser for this exit, aligned with the country it comes out in.
 *
 * The timezone and locale are launch flags, so an exit being seen for the first time is
 * launched once to find out where it lands and then relaunched with that applied. The
 * answer is kept, so this costs one extra launch per exit ever -- not per job.
 */
async function launchAlignedBrowser(
  proxyUrl: string | undefined,
  deadline: number,
): Promise<LaunchedBrowser> {
  const launched = await launchCfBrowser(proxyUrl);
  if (launched.geo) return launched;

  const geo = await probeExitGeo(launched.page, launched.key, deadline);
  if (!geo?.tz || msLeft(deadline) <= 0) return launched;

  await launched.close();
  // A licence key is one session at a time, and the service does not always have the old
  // one torn down by the time the next launch asks for it -- relaunching straight away can
  // be refused, which the keyed build answers by quitting during startup. The seat is
  // already free locally; this is purely to let the far side catch up.
  await sleep((await cfTuning()).relaunchSettleMs, deadline);
  return launchCfBrowser(proxyUrl);
}

/**
 * Clicks an element by moving the pointer to it, rather than through `page.click`.
 *
 * The driver's own click first waits for the element to be scrolled into view and stable,
 * both settled off frame callbacks. Under Xvfb, with a window Chromium believes is
 * occluded, those callbacks are throttled and never arrive: the call then hangs until the
 * timeout and the step reports a press that never happened. Scrolling synchronously in the
 * page and dispatching real pointer events avoids the wait entirely, and is closer to what
 * a person does anyway.
 */
async function clickElement(page: Page, selector: string): Promise<boolean> {
  const box = await page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, selector)
    .catch(() => null);
  if (!box) return false;
  // Approach then press, as a pointer would
  let failure: string | undefined;
  await page.mouse.move(box.x - 8, box.y + 6).catch((err: any) => {
    failure = `move: ${err?.message ?? err}`;
  });
  await page.mouse.click(box.x, box.y).catch((err: any) => {
    failure = `click: ${err?.message ?? err}`;
  });
  if (failure) {
    console.warn(`[cloudflare] pointer ${failure}`);
    return false;
  }
  return true;
}

// Full-page Cloudflare interstitial ("Just a moment...").
async function isInterstitial(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => "")) || "";
  if (/just a moment|checking your browser|attention required|请稍候|正在验证/i.test(title)) return true;
  return page
    .evaluate(() => !!document.querySelector("#challenge-form, #challenge-running"))
    .catch(() => false);
}

// Turnstile renders into a shadow root when a site calls turnstile.render() itself, and
// document.querySelector cannot see inside one -- so every widget lookup walks shadow
// roots as well, or an app's challenge looks absent while it sits there unsolved.
const DEEP_QUERY_FN = `
  function __deepQuery(selector) {
    var out = [];
    (function walk(root) {
      out.push.apply(out, Array.prototype.slice.call(root.querySelectorAll(selector)));
      Array.prototype.forEach.call(root.querySelectorAll('*'), function (el) {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    })(document);
    return out;
  }
`;

/**
 * An interactive Turnstile challenge is on the page. The response field is the reliable
 * marker: Turnstile creates it for every widget, including ones rendered explicitly into
 * the site's own element, whose iframe then lives in a closed shadow root that no
 * selector can reach.
 */
async function hasTurnstileWidget(page: Page): Promise<boolean> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         return __deepQuery(".cf-turnstile, iframe[src*='challenges.cloudflare.com'], [name='cf-turnstile-response']").length > 0;
       })()`,
    )
    .then((v) => !!v)
    .catch(() => false);
}

/** The Turnstile script is loaded, so a widget may still be rendered later. */
async function hasTurnstileScript(page: Page): Promise<boolean> {
  return page
    .evaluate(
      () => !!document.querySelector("script[src*='challenges.cloudflare.com/turnstile']"),
    )
    .catch(() => false);
}

// Either form counts when deciding whether a page is challenge-gated at all.
async function hasTurnstile(page: Page): Promise<boolean> {
  return (await hasTurnstileWidget(page)) || (await hasTurnstileScript(page));
}

/**
 * Nothing challenge-shaped is on the page any more, and there is something else there
 * instead. The second half matters: a document that is still loading has no interstitial
 * markers in it either, and calling that "cleared" logs a checkin that never happened.
 */
async function challengeGone(page: Page): Promise<boolean> {
  if (await isInterstitial(page)) return false;
  if (await hasTurnstileWidget(page)) return false;
  const rendered = await page
    .evaluate(() => (document.body?.innerText ?? "").trim().length)
    .catch(() => 0);
  return rendered > 0;
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Locates the Turnstile widget's iframe through CDP with `pierce`, the only way to see
 * an element inside the closed shadow root Turnstile renders into. Returns its
 * on-screen box.
 */
async function turnstileBoxViaCdp(page: Page): Promise<Box | null> {
  let session: any;
  try {
    session = await page.context().newCDPSession(page);
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });

    let nodeId: number | null = null;
    const walk = (node: any) => {
      if (nodeId) return;
      if (node.nodeName === "IFRAME") {
        const attrs: string[] = node.attributes ?? [];
        for (let i = 0; i < attrs.length; i += 2) {
          if (attrs[i] === "src" && /challenges\.cloudflare\.com/.test(attrs[i + 1] ?? "")) {
            nodeId = node.nodeId;
            return;
          }
        }
      }
      for (const child of node.children ?? []) walk(child);
      for (const shadow of node.shadowRoots ?? []) walk(shadow);
      if (node.contentDocument) walk(node.contentDocument);
    };
    walk(root);
    if (!nodeId) return null;

    const { model } = await session.send("DOM.getBoxModel", { nodeId });
    const border = model.border as number[]; // x1,y1,x2,y2,x3,y3,x4,y4
    return {
      x: border[0],
      y: border[1],
      width: border[2] - border[0],
      height: border[5] - border[1],
    };
  } catch {
    return null;
  } finally {
    await session?.detach?.().catch(() => {});
  }
}

/**
 * Clicks an embedded Turnstile widget's checkbox with a real mouse click at its left
 * edge, where the checkbox sits.
 *
 * Nothing else clicks it: an interactive widget waits for a real press, and aiming at the
 * response field's parent does not work -- for an explicitly rendered widget that is a
 * wrapper holding nothing but a hidden input, a zero-sized box whose click lands nowhere.
 * Hence the CDP lookup, with the widget's sized ancestor as a fallback.
 */
export async function clickTurnstileWidget(page: Page): Promise<boolean> {
  let box = await turnstileBoxViaCdp(page);

  if (!box || box.width < 20) {
    box = (await page
      .evaluate(
        `(function () { ${DEEP_QUERY_FN}
           var el = __deepQuery("iframe[src*='challenges.cloudflare.com'], .cf-turnstile, [name='cf-turnstile-response']")[0];
           if (!el) return null;
           // Climb to something actually laid out: the widget's own slot in the page
           var node = el;
           for (var i = 0; node && i < 4; i++, node = node.parentElement) {
             var r = node.getBoundingClientRect();
             if (r.width >= 200 && r.height >= 30) {
               node.scrollIntoView({ block: 'center' });
               r = node.getBoundingClientRect();
               return { x: r.x, y: r.y, width: r.width, height: r.height };
             }
           }
           return null;
         })()`,
      )
      .catch(() => null)) as Box | null;
  }
  if (!box || box.width < 20) return false;

  // Approach the checkbox like a pointer would, then click it
  await page.mouse.move(box.x + 12, box.y + box.height / 2 + 8).catch(() => {});
  await page.mouse.click(box.x + 30, box.y + box.height / 2).catch(() => {});
  return true;
}

// A solved Turnstile fills its hidden response field with a token; the widget API is
// asked as well, since a site can render the widget somewhere this cannot reach.
export async function turnstileToken(page: Page): Promise<string> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         var el = __deepQuery("[name='cf-turnstile-response']")[0];
         if (el && el.value) return el.value;
         try { return window.turnstile && window.turnstile.getResponse ? (window.turnstile.getResponse() || '') : ''; }
         catch (e) { return ''; }
       })()`,
    )
    .then((v) => (typeof v === "string" ? v : ""))
    .catch(() => "");
}

/**
 * Whether a Turnstile token means the page is through.
 *
 * A token issued to a widget the site itself put on its page is the deliverable: the site
 * takes it from there. On a full-page interstitial it proves nothing -- Cloudflare's own
 * widget satisfies itself and hands the token back, and the edge still refuses an address
 * it has decided against, leaving the interstitial up. Believing the token there reports a
 * challenge passed that never was, and whatever runs next acts on a page with none of the
 * site on it.
 */
export function turnstilePassed(token: string, onInterstitial: boolean): boolean {
  return !!token && !onInterstitial;
}

// Text a page shows when the challenge was refused outright. Recognising it ends the
// attempt at once instead of waiting out the timeout, so the next exit can be tried.
const REFUSED_RE =
  /人机验证失败|人機驗證失敗|验证失败|驗證失敗|verification failed|challenge failed|请刷新页面重试|請刷新頁面重試|invalid turnstile token|error occurred during verification/i;

// An app asking for a human check in its own wording, typically in a dialog raised by
// pressing the checkin control. The widget behind it renders a moment later, so this is
// also the signal to keep waiting for one.
const VERIFY_REQUIRED_RE =
  /请完成人机验证|請完成人機驗證|完成人机验证|完成人機驗證|需要人机验证|需要人機驗證|complete the (?:human )?verification|verify you are human/i;

// Text a verify portal shows once the identity check has gone through. An adverb may sit
// between the words ("驗證已經通過"), so a short gap is allowed -- but never one carrying a
// negation, which would read "驗證未通過" as a pass.
const NOT_NEGATED = "[^未不沒没無无失]";
const SUCCESS_RE = new RegExp(
  "success|verified|verification complete|completed|已(驗|验)[證证]" +
    `|(驗|验)[證证]${NOT_NEGATED}{0,3}(成功|完成|通過|通过)` +
    `|已${NOT_NEGATED}{0,2}(通過|通过)`,
  "i",
);

// Some verify portals only engage Turnstile after the user clicks a button. A
// real (CDP) click is required -- Turnstile ignores untrusted element.click()
// events. Generic: prefer a button whose label reads like a verify/continue
// action, otherwise fall back to the sole visible button (these portals almost
// always have exactly one), so it isn't tied to any one site's wording. Nothing is
// clicked on a page full of unrelated controls (e.g. a Mini App panel with a nav
// sidebar), where guessing would navigate away from the challenge.
const VERIFY_LABEL_RE =
  /verify|驗證|验证|continue|submit|確認|确认|start|begin|開始|开始|proceed/i;

/**
 * Which control to press to engage a verify portal's Turnstile, or null to press nothing.
 *
 * A verify portal is a near-empty page: a widget and a button. Anything with a site around
 * it is not one, and guessing there presses the site's own controls -- a login form's
 * "send verification code" reads exactly like a verify button, and pressing it submits the
 * form with whatever is in it.
 */
export function verifyPortalChoice(labels: string[]): number | null {
  if (labels.length > 3) return null;
  const named = labels.findIndex((label) => VERIFY_LABEL_RE.test(label));
  if (named >= 0) return named;
  return labels.length === 1 ? 0 : null;
}

// Visible controls, in document order, shared by the two passes below so the index one
// returns still means the same element to the other.
const VISIBLE_CONTROLS_FN = `
  function __visibleControls() {
    return Array.prototype.slice
      .call(document.querySelectorAll("button,a[href],[role=button],input[type=submit],input[type=button]"))
      .filter(function (el) { return el.offsetParent !== null || el.getClientRects().length > 0; });
  }
`;

async function clickVerifyButton(page: Page): Promise<boolean> {
  const labels = (await page
    .evaluate(
      `(function () { ${VISIBLE_CONTROLS_FN}
         return __visibleControls().map(function (el) { return el.textContent || el.value || ""; });
       })()`,
    )
    .catch(() => null)) as string[] | null;
  if (!labels) return false;

  const at = verifyPortalChoice(labels);
  if (at === null) return false;

  const sel = await page
    .evaluate(
      `(function () { ${VISIBLE_CONTROLS_FN}
         var el = __visibleControls()[${at}];
         if (!el) return null;
         el.setAttribute("data-cf-click", "1");
         return "[data-cf-click='1']";
       })()`,
    )
    .catch(() => null);
  if (!sel) return false;
  return clickElement(page, sel as string);
}


// Cap (capjs.js.org) is a self-hosted proof-of-work captcha some apps use instead of
// Turnstile: a checkbox reading "Verify you're human" inside a custom element's shadow
// root. Ticking it runs the work in the browser and the app proceeds on its own once a
// token is issued, so it needs no service and no key -- only a real click and patience.
const CAP_SELECTOR = "cap-widget,cap-floating-widget,[data-cap-api-endpoint]";
const CAP_ASKING_RE = /verify you'?re human|i'?m not a robot|请完成验证/i;
const CAP_SOLVED_RE = /you'?re human|verified|完成|成功/i;

/** A Cap widget is on the page (light DOM or inside a shadow root). */
async function hasCapWidget(page: Page): Promise<boolean> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         return __deepQuery(${JSON.stringify(CAP_SELECTOR)}).length > 0;
       })()`,
    )
    .then((v) => !!v)
    .catch(() => false);
}

/** What the Cap widget is showing, and whether it has produced a token. */
async function capState(page: Page): Promise<{ asking: boolean; solved: boolean }> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         var w = __deepQuery(${JSON.stringify(CAP_SELECTOR)})[0];
         if (!w) return { asking: false, solved: false };
         var root = w.shadowRoot || w;
         var text = (root.textContent || "") + " " + (w.textContent || "");
         var token = w.getAttribute("data-cap-token") || w.getAttribute("token") || "";
         if (!token) {
           var field = (root.querySelector ? root.querySelector("input") : null);
           token = (field && field.value) || "";
         }
         return {
           asking: ${CAP_ASKING_RE.toString()}.test(text),
           solved: !!token || (${CAP_SOLVED_RE.toString()}.test(text) && !${CAP_ASKING_RE.toString()}.test(text)),
         };
       })()`,
    )
    .then((v: any) => ({ asking: !!v?.asking, solved: !!v?.solved }))
    .catch(() => ({ asking: false, solved: false }));
}

/** Ticks the Cap checkbox: a real pointer press at its box, shadow root and all. */
async function clickCapWidget(page: Page): Promise<boolean> {
  const box = (await page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         var w = __deepQuery(${JSON.stringify(CAP_SELECTOR)})[0];
         if (!w) return null;
         w.scrollIntoView({ block: "center" });
         var r = w.getBoundingClientRect();
         if (r.width < 10 || r.height < 10) return null;
         return { x: r.x, y: r.y, width: r.width, height: r.height };
       })()`,
    )
    .catch(() => null)) as Box | null;
  if (!box) return false;
  // The checkbox sits at the left edge, as it does in Turnstile
  await page.mouse.move(box.x + 12, box.y + box.height / 2 + 6).catch(() => {});
  await page.mouse.click(box.x + 22, box.y + box.height / 2).catch(() => {});
  return true;
}

/**
 * Ticks a Cap checkbox and waits for the app to move on. The work happens in the browser
 * and takes a moment; the app is what completes the action once its token arrives, so the
 * app's own success wording counts as much as the widget's state.
 */
async function solveCap(page: Page, deadline: number): Promise<boolean> {
  const tune = await cfTuning();
  if (!(await clickCapWidget(page))) return false;
  let clicks = 1;
  while (Date.now() < deadline) {
    await sleep(tune.pollMs, deadline);
    const state = await capState(page);
    const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (state.solved || SUCCESS_RE.test(body)) return true;
    if (REFUSED_RE.test(body)) return false;
    // Gone from the page altogether: the app took it and closed the dialog
    if (!state.asking && !VERIFY_REQUIRED_RE.test(body)) return true;
    // Nudge it a couple of times in case the first press missed the checkbox
    if (state.asking && clicks < 3 && Date.now() > deadline - tune.challengeTimeoutMs + clicks * 8_000) {
      clicks++;
      await clickCapWidget(page);
    }
  }
  return false;
}

// telegram-web-app.js posts events to the host client; with no host it either
// throws or silently drops them, and apps that call WebApp.ready() first then break.
// This stub is what a Telegram Android/iOS webview exposes, so the bridge works and
// the signed initData in the URL fragment is picked up as normal.
const WEBVIEW_PROXY_SHIM = `
  window.TelegramWebviewProxy = window.TelegramWebviewProxy || {
    postEvent: function (type, data) {
      try { window.dispatchEvent(new CustomEvent('tg-post', { detail: { type: type, data: data } })); } catch (e) {}
    },
  };
`;

// Labels that clearly mean "check in", and the states that mean it is already done.
// Deliberately narrow: only a control carrying such a label is pressed, so nothing
// else in the app (points spending, lotteries) can be triggered.
const IN_APP_LABEL_RE = /签到|簽到|打卡|领取|領取|check\s?-?in|sign\s?-?in/i;
const IN_APP_DONE_RE = /已签到|已簽到|已打卡|已领取|已領取|已完成|already/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LOADING_RE = /loading|加载|加載|載入|please wait|请稍候|請稍候/i;

/**
 * Waits for the page to finish arriving before anything judges it.
 *
 * `goto` returns at DOMContentLoaded, which for a Mini App is still a spinner and for a
 * challenged page can be an empty document -- Cloudflare's interstitial writes its title
 * and markers a moment later. Judged at that instant the page looks challenge-free, and
 * the steps then run against an interstitial that will never show them what they want.
 *
 * Returns as soon as a challenge shows up, or once the rendered text has stopped changing.
 */
async function waitForPageReady(page: Page, budgetDeadline: number): Promise<void> {
  const tune = await cfTuning();
  const deadline = Math.min(Date.now() + tune.appReadyTimeoutMs, budgetDeadline);
  let previous = "";
  while (Date.now() < deadline) {
    if ((await hasTurnstile(page)) || (await isInterstitial(page))) return;
    const text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).trim();
    const booting = !text || text.length < 40 || LOADING_RE.test(text);
    if (!booting && text === previous) return;
    previous = text;
    await sleep(tune.readyPollMs, deadline);
  }
}

/**
 * A full-page challenge is up, so none of the site is on screen to act on.
 *
 * Deliberately not "a Turnstile widget is present": plenty of sites put one on their own
 * login form, where the page around it is perfectly usable and the widget verifies itself
 * while the steps get on with filling the form in.
 */
async function interstitialOnPage(page: Page): Promise<boolean> {
  return isInterstitial(page);
}

/** How the thing that got clicked was identified, worst last. */
type InAppTargetKind = "selector" | "control" | "pointer" | "in-card" | "text";

type InAppTarget = { label: string; kind: InAppTargetKind; done: boolean };

/**
 * Finds the control to press inside the Mini App.
 *
 * A label is not a control. These apps put the wording in several places at once -- a
 * card captioned "每日签到" over a heading "立即签到" beside a button reading "签到" -- and
 * taking the first match in document order lands on the caption, which clicks nothing
 * while looking like success. So every match is collected and the most control-like one
 * wins: a real button or link first, then an element that at least behaves like one, then
 * a button sitting in the same card as the label, and only then the bare text.
 *
 * `wanted` may instead be a CSS selector (`css:` prefix), which skips all of this and
 * presses exactly what the selector names.
 */
async function findInAppCheckin(
  page: Page,
  labelRe: RegExp,
  selector?: string,
): Promise<InAppTarget | null> {
  return page
    .evaluate(
      ({ labelSrc, doneSrc, sel }: { labelSrc: string; doneSrc: string; sel: string }) => {
        const label = new RegExp(labelSrc, "i");
        const done = new RegExp(doneSrc, "i");
        const CONTROL_SEL = "button,[role=button],a[href],input[type=submit],input[type=button]";

        // The helpers hang off an object rather than standing as named consts, and every
        // browser-side function in this file has to. The dev server loads it through tsx,
        // whose keep-names transform rewrites a function bound to a name into a
        // `__name(fn, "name")` call -- and that helper exists only in the module scope on
        // this side, never in the page. The body then throws on its first line, which the
        // catch below turns into "no checkin control here". A member assignment carries no
        // inferred name, so it comes through untouched under tsx and tsc alike.
        const fn = {} as {
          visible: (el: Element) => boolean;
          spent: (el: Element) => boolean;
          describe: (el: Element, fallback: string) => string;
          take: (
            el: Element,
            kind: string,
            fallbackLabel: string,
          ) => { label: string; kind: string; done: boolean };
          ownText: (el: Element) => string;
          candidatesFor: (el: Element) => Array<{ el: Element; kind: string }>;
        };

        fn.visible = (el) =>
          (el as HTMLElement).offsetParent !== null || el.getClientRects().length > 0;

        fn.spent = (el) =>
          (el as HTMLButtonElement).disabled ||
          el.getAttribute("aria-disabled") === "true" ||
          el.closest("[disabled],[aria-disabled='true']") !== null;

        fn.describe = (el, fallback) =>
          ((el.textContent ?? "").trim() || (el as HTMLInputElement).value || fallback).slice(0, 40);

        fn.take = (el, kind, fallbackLabel) => {
          if (fn.spent(el) || done.test(fn.describe(el, ""))) {
            return { label: fn.describe(el, fallbackLabel), kind: kind, done: true };
          }
          el.setAttribute("data-cf-checkin", "1");
          return { label: fn.describe(el, fallbackLabel), kind: kind, done: false };
        };

        // An explicit selector is taken at its word: first visible match.
        if (sel) {
          const hit = Array.from(document.querySelectorAll(sel)).find((el) => fn.visible(el));
          return hit ? fn.take(hit, "selector", sel) : null;
        }

        // Direct text nodes only, so the element holding the label is found rather than
        // every wrapper around it.
        fn.ownText = (el) =>
          Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent ?? "")
            .join("")
            .trim();

        // Ranked candidates for one labelled element: the real control it sits in, an
        // ancestor that behaves like one, a control inside the same card, or the text.
        fn.candidatesFor = (el) => {
          const out: Array<{ el: Element; kind: string }> = [];
          const semantic = el.closest(CONTROL_SEL);
          if (semantic && fn.visible(semantic)) out.push({ el: semantic, kind: "control" });

          let node: Element | null = el;
          for (let i = 0; node && i < 3; i++, node = node.parentElement) {
            if (getComputedStyle(node as HTMLElement).cursor === "pointer") {
              out.push({ el: node, kind: "pointer" });
              break;
            }
          }

          // The label captions a card; the button that acts on it lives in that card.
          let box: Element | null = el;
          for (let i = 0; box && i < 4; i++, box = box.parentElement) {
            const inside = Array.from(box.querySelectorAll(CONTROL_SEL)).filter(
              (c) =>
                fn.visible(c) &&
                label.test((c.textContent ?? "") || (c as HTMLInputElement).value || ""),
            );
            if (inside.length) {
              out.push({ el: inside[0], kind: "in-card" });
              break;
            }
          }

          out.push({ el, kind: "text" });
          return out;
        };

        const RANK = ["control", "pointer", "in-card", "text"];
        let best: { el: Element; kind: string; fallback: string } | null = null;

        for (const el of Array.from(document.querySelectorAll("*"))) {
          const text = (fn.ownText(el) || (el as HTMLInputElement).value || "").trim();
          if (!text || text.length > 30 || !label.test(text)) continue;
          if (!fn.visible(el)) continue;

          for (const cand of fn.candidatesFor(el)) {
            if (!best || RANK.indexOf(cand.kind) < RANK.indexOf(best.kind)) {
              best = { el: cand.el, kind: cand.kind, fallback: text };
            }
            break; // only this element's best candidate competes
          }
          // A real control is as good as it gets; no need to look further
          if (best && best.kind === "control") break;
        }

        return best ? fn.take(best.el, best.kind, best.fallback) : null;
      },
      { labelSrc: labelRe.source, doneSrc: IN_APP_DONE_RE.source, sel: selector ?? "" },
    )
    .catch((err: any) => {
      // Swallowing this once cost a long hunt: a lookup that throws looks exactly like
      // an app with no checkin control on it.
      console.warn(`[cloudflare] in-app lookup failed: ${err?.message ?? err}`);
      return null;
    }) as Promise<InAppTarget | null>;
}

/**
 * The wordings a step will accept, split on `|`: `Join giveaway|参与抽奖|加入抽奖` presses
 * whichever of them the app actually has. The same control is worded differently depending
 * on the language the app decides to render in, and one step should cover the lot rather
 * than the operator keeping a template per language. `|` already means "any of these" for
 * the success/fail matchers, so it reads the same way here.
 */
export function parseLabelAlternatives(wanted: string): string[] {
  return wanted
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** `css:<selector>` in a step names the element to press outright. */
function parseSelectorStep(step: string): string | undefined {
  const m = /^css:(.+)$/i.exec(step.trim());
  return m ? m[1].trim() : undefined;
}

type ClickOutcome = {
  /** What to show in the log. */
  outcome: string;
  /** The app said this action is already spent. */
  done: boolean;
  /** Nothing control-like was pressed, so the click may well have done nothing. */
  weak: boolean;
};

/**
 * Presses one control inside the Mini App: the one named by `wanted` (a label, or a
 * `css:` selector), or a checkin-worded one when nothing is given. Returns what happened,
 * or undefined when the label is nowhere on the page.
 */
async function clickInAppControl(
  page: Page,
  wanted?: string,
): Promise<ClickOutcome | undefined> {
  const selector = wanted ? parseSelectorStep(wanted) : undefined;
  // A CSS selector is taken whole -- `|` is a legitimate character in one (namespaces,
  // `[attr|=value]`), so only a plain label is read as a list of alternatives.
  const alternatives = wanted && !selector ? parseLabelAlternatives(wanted) : [];
  const labelRe = alternatives.length
    ? new RegExp(alternatives.map(escapeRe).join("|"), "i")
    : IN_APP_LABEL_RE;

  const target = await findInAppCheckin(page, labelRe, selector);
  if (target?.done) {
    return { outcome: `already done: ${target.label}`, done: true, weak: false };
  }

  // Nothing control-like matched. Before pressing inert text -- or giving up -- see
  // whether the app is saying the action is already spent: a checkin done earlier today
  // takes its button away but leaves the wording ("每日签到 … 今日已签到") behind, which
  // still matches the label the job names.
  if (!selector && (!target || target.kind === "text")) {
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (IN_APP_DONE_RE.test(text) && (labelRe.test(text) || IN_APP_LABEL_RE.test(text))) {
      return { outcome: "already done (from the page's own wording)", done: true, weak: false };
    }
  }

  if (target) {
    // Real (CDP) click: mini apps commonly bind pointer events, not synthetic clicks
    const landed = await clickElement(page, "[data-cf-checkin='1']");
    await page.evaluate(() =>
      document.querySelector("[data-cf-checkin]")?.removeAttribute("data-cf-checkin"),
    ).catch(() => {});
    if (!landed) {
      console.warn("[cloudflare] in-app click did not land: the control has no on-screen box");
      return { outcome: `${target.label} (could not be clicked)`, done: false, weak: true };
    }
    // "text" means the label itself was clicked for want of anything better, which for
    // an app that binds its handler to a button does nothing at all -- say so.
    const weak = target.kind === "text";
    return {
      outcome: weak ? `${target.label} (plain text, not a control)` : target.label,
      done: false,
      weak,
    };
  }

  return undefined;
}

// Text of the dialog the app is showing, or the whole page when there is none: the
// question to answer is almost always inside a modal raised by the previous step.
async function inAppQuestion(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const dialogs = Array.from(
        document.querySelectorAll("[role=dialog],dialog,[class*='dialog'],[class*='modal']"),
      ) as HTMLElement[];
      const open = dialogs.filter((d) => d.offsetParent !== null || d.getClientRects().length > 0);
      // Innermost open dialog holds the prompt; outer ones are just backdrops
      const inner = open.length ? open[open.length - 1] : null;
      return (inner?.innerText ?? document.body?.innerText ?? "").trim();
    })
    .catch(() => "");
}

/** Solves the arithmetic captchas mini apps use ("5 + 3 = ?"). */
export function solveArithmetic(text: string): string | undefined {
  const m = text.match(/(-?\d+)\s*([+\-*x×÷/])\s*(-?\d+)\s*(?:=\s*[?？]?|[?？])/);
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[3]);
  switch (m[2]) {
    case "+": return String(a + b);
    case "-": return String(a - b);
    case "*": case "x": case "×": return String(a * b);
    default: return b === 0 ? undefined : String(a / b);
  }
}

// Types an answer into the app's visible input, preferring one inside the open dialog.
async function fillInAppAnswer(page: Page, answer: string): Promise<boolean> {
  const ok = await page
    .evaluate(() => {
      const fields = Array.from(
        document.querySelectorAll("input:not([type=hidden]),textarea"),
      ) as HTMLInputElement[];
      const usable = fields.filter(
        (f) =>
          !f.disabled &&
          !f.readOnly &&
          !["checkbox", "radio", "submit", "button"].includes(f.type) &&
          (f.offsetParent !== null || f.getClientRects().length > 0),
      );
      // The last visible field is the one the newest dialog raised
      const target = usable.filter((f) => !f.value).pop() ?? usable.pop();
      if (!target) return false;
      target.setAttribute("data-cf-input", "1");
      return true;
    })
    .catch(() => false);
  if (!ok) return false;
  await clickElement(page, "[data-cf-input='1']");
  await typeIntoFocused(page, answer);
  await page
    .evaluate(() => document.querySelector("[data-cf-input]")?.removeAttribute("data-cf-input"))
    .catch(() => {});
  return true;
}

/**
 * Runs the configured in-app steps in order, letting the app settle between them so
 * each step can render what the next one needs (press checkin, answer its captcha,
 * confirm). Stops at the first step that cannot be carried out, and reports how far
 * it got. `ok` is false when a step the caller asked for could not be carried out,
 * so a page where nothing was pressed is not mistaken for a completed checkin.
 */
/**
 * `delay(2500)` (or `delay(2.5s)`) as a step: wait before the next one runs, for an app
 * that needs a moment to settle. Returns null for anything that is not a delay step.
 */
export function parseDelayStep(step: string | undefined): number | null {
  const m = /^delay\(\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*\)$/i.exec(step?.trim() ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(m[2]?.toLowerCase() === "s" ? n * 1000 : n);
}

/**
 * `{aiBtn}`, or `{aiBtn:the checkin button}` to say which one. Returns null for anything
 * that is not an AI-button step.
 */
export function parseAiBtnStep(step: string | undefined): { hint?: string } | null {
  const m = /^\{\s*aibtn\s*(?::([\s\S]*))?\}$/i.exec(step?.trim() ?? "");
  if (!m) return null;
  const hint = m[1]?.trim();
  return hint ? { hint } : {};
}

/**
 * `scroll(500)` moves down 500px; `scroll(120, 500)` moves both axes, and the named forms
 * (`scroll(y=500)`, `scroll(x:-120)`) move one. Negative figures scroll back. Returns null
 * for anything that is not a scroll step.
 */
export function parseScrollStep(step: string | undefined): { x: number; y: number } | null {
  const m = /^scroll\(([^)]*)\)$/i.exec(step?.trim() ?? "");
  if (!m) return null;
  const parts = m[1]
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const bare: number[] = [];
  let x: number | undefined;
  let y: number | undefined;
  for (const part of parts) {
    const named = /^([xy])\s*[=:]\s*(-?\d+(?:\.\d+)?)$/i.exec(part);
    if (named) {
      const n = Math.round(Number(named[2]));
      if (named[1].toLowerCase() === "x") x = n;
      else y = n;
      continue;
    }
    if (!/^-?\d+(?:\.\d+)?$/.test(part)) return null;
    bare.push(Math.round(Number(part)));
  }
  // Bare figures are positional, and cannot be mixed with named axes: `scroll(x=10, 20)`
  // reads either way, so it is rejected rather than guessed at.
  if (bare.length) {
    if (x !== undefined || y !== undefined) return null;
    // A lone figure is the vertical move, which is what a scroll almost always means
    if (bare.length === 1) y = bare[0];
    else if (bare.length === 2) [x, y] = bare;
    else return null;
  }
  return { x: x ?? 0, y: y ?? 0 };
}

/**
 * Scrolls the page by `x`/`y` pixels, clamped to the content: a figure past the end simply
 * lands at the end, which is how "scroll all the way down" is written.
 *
 * Picking *what* to scroll is the whole difficulty. Mini Apps pin the document
 * (`body { position: fixed; overflow: hidden }`) and scroll a container inside it, and they
 * commonly keep the other tabs mounted as hidden panes -- each a full-viewport box with a
 * scroll extent of its own. Choosing by size alone lands on one of those: the numbers in the
 * log look like a real scroll while nothing on screen has moved. So the target is taken from
 * what is actually painted at the centre of the viewport, walking up to the nearest
 * scrollable ancestor -- which is what a wheel there would have moved.
 */
async function scrollPageBy(
  page: Page,
  x: number,
  y: number,
): Promise<{ x: number; y: number; maxX: number; maxY: number; what: string } | null> {
  return await page
    .evaluate(
      ({ dx, dy }: { dx: number; dy: number }) => {
        // Hung off an object, not bound to names: see the note in `findInAppCheckin`. Named
        // here, the dev server's loader rewrites them into calls to a helper the page does
        // not have, and every scroll step reports that nothing on the page scrolls.
        const fn = {} as {
          isDoc: (el: Element) => boolean;
          scrollable: (el: Element) => boolean;
          underCentre: () => Element | null;
          largestOnScreen: () => Element | null;
        };

        fn.isDoc = (el) =>
          el === document.scrollingElement ||
          el === document.documentElement ||
          el === document.body;

        // The document scrolls on its own extent; anything else needs an overflow that
        // actually clips, or its scrollTop goes nowhere.
        fn.scrollable = (el) => {
          if (el.scrollHeight - el.clientHeight <= 1 && el.scrollWidth - el.clientWidth <= 1) {
            return false;
          }
          if (fn.isDoc(el)) return true;
          const style = getComputedStyle(el);
          return /auto|scroll|overlay/.test(`${style.overflowY} ${style.overflowX}`);
        };

        // Whatever is painted at the middle of the screen, then up to the first ancestor
        // that scrolls. On an ordinary page this walk ends at the document.
        fn.underCentre = () => {
          let el = document.elementFromPoint(
            Math.floor(window.innerWidth / 2),
            Math.floor(window.innerHeight / 2),
          );
          while (el) {
            if (fn.scrollable(el)) return el;
            el = el.parentElement;
          }
          return null;
        };

        // Nothing under the centre (an overlay, a gap): the biggest scroller that is on
        // screen. Hidden panes are skipped, which is the point.
        fn.largestOnScreen = () => {
          let best: Element | null = null;
          let bestArea = 0;
          for (const el of Array.from(document.querySelectorAll("*"))) {
            if (!fn.scrollable(el)) continue;
            if (typeof (el as any).checkVisibility === "function" && !(el as any).checkVisibility())
              continue;
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
            const area = r.width * r.height;
            if (area > bestArea) {
              bestArea = area;
              best = el;
            }
          }
          return best;
        };

        const doc = document.scrollingElement ?? document.documentElement;
        const target =
          fn.underCentre() ?? fn.largestOnScreen() ?? (fn.scrollable(doc) ? doc : null);
        if (!target) return null;

        const maxX = Math.max(0, target.scrollWidth - target.clientWidth);
        const maxY = Math.max(0, target.scrollHeight - target.clientHeight);
        target.scrollLeft = Math.min(Math.max(0, target.scrollLeft + dx), maxX);
        target.scrollTop = Math.min(Math.max(0, target.scrollTop + dy), maxY);

        // Named in the log: "scrolled 1071px" reads the same whether the right thing moved
        // or a hidden pane did, and telling those apart is the whole game here.
        const cls = String((target as HTMLElement).className ?? "")
          .split(/\s+/)
          .filter(Boolean)[0];
        return {
          x: Math.round(target.scrollLeft),
          y: Math.round(target.scrollTop),
          maxX: Math.round(maxX),
          maxY: Math.round(maxY),
          what: fn.isDoc(target)
            ? "the page"
            : `${target.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`,
        };
      },
      { dx: x, dy: y },
    )
    .catch(() => null);
}

/**
 * Carries out a scroll step and says where the page ended up, naming any axis that came to
 * rest against the end so a log can tell "moved 800px" from "there was nothing left to
 * move". Null means nothing on the page scrolls at all.
 */
async function scrollOutcome(page: Page, x: number, y: number): Promise<string | null> {
  const moved = await scrollPageBy(page, x, y);
  if (!moved) return null;
  const ends = [
    x !== 0 && moved.x === (x > 0 ? moved.maxX : 0) ? "x" : "",
    y !== 0 && moved.y === (y > 0 ? moved.maxY : 0) ? "y" : "",
  ]
    .filter(Boolean)
    .join("/");
  return `scrolled ${moved.what} to ${moved.x},${moved.y}${ends ? ` (${ends} at the end)` : ""}`;
}

async function runInAppClicks(
  page: Page,
  steps: string[],
  deadline: number,
  solveQuestion?: (question: string) => Promise<string>,
  aiLocate?: (image: string, prompt: string) => Promise<string>,
): Promise<{ trace?: string; ok: boolean; failure?: string; acted: boolean }> {
  const tune = await cfTuning();
  const done: string[] = [];
  let failure: string | undefined;
  // Whether a step actually did something to the app. Waiting and scrolling are how a step
  // gets ready to act, not acting: counting them would let a page that rendered nothing
  // report a completed checkin on the strength of a delay.
  let acted = false;

  for (const step of steps.length ? steps : [undefined]) {
    if (msLeft(deadline) <= 0) {
      failure = "ran out of time before the in-app steps finished";
      break;
    }
    const pause = parseDelayStep(step);
    if (pause !== null) {
      // Bounded by the action budget, so a long delay cannot outlive it
      await sleep(pause, deadline);
      done.push(`waited ${pause}ms`);
      continue;
    }

    // Brings a control below the fold into view so the step after this one can press it.
    // A page with nothing to scroll is not a failure -- the app may already fit on screen,
    // and the step that wanted the control will say so itself.
    const scroll = parseScrollStep(step);
    if (scroll) {
      const outcome = await scrollOutcome(page, scroll.x, scroll.y);
      done.push(outcome ?? `scroll(${scroll.x}, ${scroll.y}) found nothing that scrolls`);
      await sleep(tune.inAppStepMs, deadline);
      continue;
    }

    // Same machinery as the `ai_web_button` page step: outline every control, number it,
    // and let the model pick from the picture rather than guess at coordinates.
    const aiBtn = parseAiBtnStep(step);
    if (aiBtn) {
      if (!aiLocate) {
        failure = "{aiBtn} needs an AI model, and none is configured";
        break;
      }
      const marks = await markWebElements(page, CLICKABLE_SELECTOR, MAX_WEB_MARKS);
      if (!marks.length) {
        await clearWebMarkBadges(page);
        failure = "{aiBtn} found no control to press in the app";
        break;
      }
      const marked = await screenshotOf(page, 60);
      await clearWebMarkBadges(page);
      if (!marked) {
        failure = "{aiBtn} could not capture the app page for the AI";
        break;
      }
      const prompt = buildWebAiPrompt({ type: "ai_web_button", hint: aiBtn.hint }, marks, false);
      const reply = await aiLocate(marked, prompt).catch((err: any) => {
        throw new Error(`{aiBtn} could not reach the AI: ${err?.message ?? err}`);
      });
      const { mark } = parseWebAiReply(reply ?? "");
      const chosen = mark ? marks.find((m) => m.n === mark) : undefined;
      if (!chosen) {
        done.push(`{aiBtn} chose nothing usable`);
        failure = `{aiBtn}: the AI named no control on the page (replied "${oneLine(reply)}")`;
        break;
      }
      const what = chosen.text ? `<${chosen.tag}> "${chosen.text}"` : `<${chosen.tag}>`;
      if (!(await clickElement(page, `[data-bemby-mark='${mark}']`))) {
        failure = `{aiBtn}: ${what} has no on-screen box to press`;
        break;
      }
      done.push(`{aiBtn} pressed ${what}`);
      acted = true;
      await sleep(tune.inAppStepMs, deadline);
      continue;
    }

    if (step === "{input}" || step === "{aiInput}") {
      const question = await inAppQuestion(page);
      let answer: string | undefined;
      if (step === "{input}") {
        answer = solveArithmetic(question);
      } else if (solveQuestion) {
        answer = (await solveQuestion(question).catch(() => undefined))?.trim();
      }
      if (!answer) {
        done.push(`${step} unanswered`);
        failure = `${step} could not be answered`;
        break;
      }
      if (!(await fillInAppAnswer(page, answer))) {
        done.push(`${step} has no field to fill`);
        failure = `${step} found no input to fill`;
        break;
      }
      done.push(`${step}="${answer}"`);
      acted = true;
      await sleep(tune.inAppStepMs, deadline);
      continue;
    }

    // What the page reads now, so a click on something inert can be told from a real one
    const before = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const click = await clickInAppControl(page, step);
    if (!click) {
      // A label that never appears is worth reporting: the app may have changed
      if (step) done.push(`"${step}" not found`);
      const alts = step ? parseLabelAlternatives(step) : [];
      failure =
        alts.length > 1
          ? `none of ${alts.map((a) => `"${a}"`).join(", ")} are on the app page`
          : step
            ? `"${step}" is not on the app page`
            : "no checkin control was found in the app";
      break;
    }
    done.push(click.outcome);
    acted = true;
    await sleep(tune.inAppStepMs, deadline);

    // Pressing plain text is a guess. If the app did not react to it, nothing happened,
    // and reporting success would log a checkin that was never made.
    if (click.weak) {
      const after = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (after === before) {
        failure =
          `pressed "${click.outcome}" but it is not a control and the app did not react` +
          " -- name the control exactly, or give a CSS selector (css:...)";
        break;
      }
    }
    if (click.done) break;
  }

  // Let the last step's request round-trip before the page text is scraped
  if (done.length) await sleep(tune.inAppSettleMs, deadline);
  return { trace: done.length ? done.join(" → ") : undefined, ok: !failure, failure, acted };
}

// ── Driving a plain web page (the `open_url` action) ──────────────────────────
//
// The sub-steps either name their element with a CSS selector, or hand a screenshot to the
// vision model and let it choose. For the latter the page is marked up first: every
// candidate element is outlined and numbered, and the model replies with a number rather
// than a pixel position. Models are poor at reporting exact coordinates but good at
// reading a labelled picture, and a marker resolves back to the element's own box, so the
// press lands on something real and the log can say what was pressed.

/** Ceiling on screenshots kept for one action, so a long step list cannot bloat the log. */
const MAX_WEB_SHOTS = 24;

/** Ceiling on markers offered to the model: past this the picture is unreadable anyway. */
const MAX_WEB_MARKS = 60;

/** Spacing of the ruler drawn over the whole page for `ai_web_click_xy`, in CSS pixels. */
const WEB_GRID_PX = 100;

/**
 * Side of the close-up the second pass looks at, and the ruler drawn on it.
 *
 * One look at a full page puts a small target tens of pixels out -- enough to miss a 22px
 * Turnstile checkbox -- because the model is judging a fraction of a wide picture. The
 * same judgement over a window this size is off by a few pixels instead.
 */
const WEB_REFINE_PX = 320;
const WEB_REFINE_GRID_PX = 20;

/** Elements a press can land on. */
const CLICKABLE_SELECTOR =
  "a[href],button,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab]," +
  "input[type=submit],input[type=button],input[type=checkbox],input[type=radio]," +
  "select,summary,label,[onclick]";

/** Elements text can be typed into. */
const TYPEABLE_SELECTOR =
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox])" +
  ":not([type=radio]),textarea,[contenteditable=true],[contenteditable='']";

type WebMark = { n: number; tag: string; kind: string; text: string };

/**
 * Outlines and numbers every visible candidate element, and leaves a `data-bemby-mark`
 * attribute on each so a reply naming a number can be resolved back to the element.
 *
 * Only what is inside the viewport is marked, because that is all the screenshot shows;
 * offering the model a marker it cannot see is how it ends up picking at random.
 */
async function markWebElements(page: Page, selector: string, limit: number): Promise<WebMark[]> {
  return page
    .evaluate(
      ({ sel, max }: { sel: string; max: number }) => {
        for (const el of Array.from(document.querySelectorAll("[data-bemby-mark]")))
          el.removeAttribute("data-bemby-mark");
        for (const el of Array.from(document.querySelectorAll(".__bemby_mark"))) el.remove();

        const out: { n: number; tag: string; kind: string; text: string }[] = [];
        let n = 0;
        for (const node of Array.from(document.querySelectorAll(sel))) {
          const el = node as HTMLElement & { disabled?: boolean; value?: string; name?: string };
          if (el.disabled) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none") continue;
          if (Number(cs.opacity) < 0.05) continue;

          n++;
          el.setAttribute("data-bemby-mark", String(n));

          const ring = document.createElement("div");
          ring.className = "__bemby_mark";
          ring.style.cssText =
            "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #e11d48;" +
            `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
          const badge = document.createElement("div");
          badge.className = "__bemby_mark";
          badge.textContent = String(n);
          badge.style.cssText =
            "position:fixed;pointer-events:none;z-index:2147483647;background:#e11d48;color:#fff;" +
            "font:bold 12px/1.1 monospace;padding:2px 4px;border-radius:3px;" +
            `left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top - 14)}px`;
          document.body.appendChild(ring);
          document.body.appendChild(badge);

          const label =
            (el.innerText || el.value || el.getAttribute("placeholder") || "").trim() ||
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.name ||
            "";
          out.push({
            n,
            tag: el.tagName.toLowerCase(),
            kind: el.getAttribute("type") ?? "",
            text: label.replace(/\s+/g, " ").slice(0, 60),
          });
          if (n >= max) break;
        }
        return out;
      },
      { sel: selector, max: limit },
    )
    .catch(() => [] as WebMark[]);
}

/**
 * Rules the page with a labelled grid, for the step that asks for a position rather than a
 * marker. A model reads a coordinate off visible gridlines far better than it estimates one
 * from a bare picture, and the lines come off again before anything is clicked.
 *
 * The overlay carries the same `__bemby_mark` class as the marker badges, so
 * `clearWebMarkBadges` takes both away.
 */
async function drawWebGrid(page: Page, gap: number, frame?: WebRect): Promise<void> {
  // Deliberately written without an inner helper function. The dev server runs this file
  // through tsx, whose keep-names transform wraps any named function in a `__name` helper
  // that does not exist inside the page -- which throws, and the catch below would hide it.
  const failure = await page
    .evaluate(
      ({ step, box }: { step: number; box: WebRect | null }) => {
        for (const el of Array.from(document.querySelectorAll(".__bemby_mark"))) el.remove();

        // Labels hug the edges of what will actually be captured, not the edges of the
        // page: on the close-up pass the page's own left edge is outside the shot, and a
        // gridline whose figure is off-picture is a gridline the model cannot read
        const view = box ?? { x: 0, y: 0, width: innerWidth, height: innerHeight };
        const right = view.x + view.width;
        const bottom = view.y + view.height;
        const base = "position:fixed;pointer-events:none;z-index:2147483646;";
        const line = `${base}background:rgba(225,29,72,.30);`;
        const label =
          `${base}color:#e11d48;font:bold 10px/1 monospace;` +
          "background:rgba(255,255,255,.75);padding:1px 2px;";

        let html = "";
        for (let x = Math.ceil(view.x / step) * step; x < right; x += step) {
          if (x <= view.x) continue;
          html += `<div style="${line}left:${x}px;top:${view.y}px;width:1px;height:${view.height}px"></div>`;
          html += `<div style="${label}left:${x + 2}px;top:${view.y}px">${x}</div>`;
        }
        for (let y = Math.ceil(view.y / step) * step; y < bottom; y += step) {
          if (y <= view.y) continue;
          html += `<div style="${line}left:${view.x}px;top:${y}px;width:${view.width}px;height:1px"></div>`;
          html += `<div style="${label}left:${view.x}px;top:${y + 2}px">${y}</div>`;
        }

        const holder = document.createElement("div");
        holder.className = "__bemby_mark";
        holder.innerHTML = html;
        document.body.appendChild(holder);
        return holder.childElementCount ? undefined : "the grid drew no lines";
      },
      { step: gap, box: frame ?? null },
    )
    .catch((err: any) => `the grid could not be drawn (${err?.message ?? err})`);
  // A missing ruler is the difference between a click on the target and one tens of pixels
  // off it, so the step fails here rather than asking the model to guess
  if (failure) throw new Error(failure);
}

/** Takes the outlines and numbers off again, leaving the `data-bemby-mark` attributes. */
async function clearWebMarkBadges(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      for (const el of Array.from(document.querySelectorAll(".__bemby_mark"))) el.remove();
    })
    .catch(() => {});
}

/** One line per marker, so the model can match a number in the picture to what it is. */
function describeMarks(marks: WebMark[]): string {
  return marks
    .map((m) => {
      const kind = m.kind ? `${m.tag}[${m.kind}]` : m.tag;
      return `${m.n}: <${kind}>${m.text ? ` "${m.text}"` : " (no label)"}`;
    })
    .join("\n");
}

/**
 * Pulls the marker number and any text out of the model's reply. A JSON object is what is
 * asked for, but models wrap it in prose or fences, and some answer with a bare number --
 * all of which are a usable answer and not worth failing a step over.
 */
export function parseWebAiReply(reply: string): { mark?: number; text?: string } {
  const obj = /\{[\s\S]*\}/.exec(reply);
  if (obj) {
    try {
      const parsed = JSON.parse(obj[0]) as { mark?: unknown; text?: unknown };
      const mark = Number(parsed.mark);
      return {
        mark: Number.isInteger(mark) && mark > 0 ? mark : undefined,
        text: typeof parsed.text === "string" ? parsed.text : undefined,
      };
    } catch {
      // fall through to the looser reads below
    }
  }
  const keyed = /"?mark"?\s*[:=]\s*(\d+)/i.exec(reply);
  if (keyed) {
    const mark = Number(keyed[1]);
    if (mark > 0) return { mark };
  }
  const bare = /^\D*(\d{1,2})\b/.exec(reply.trim());
  if (bare) {
    const mark = Number(bare[1]);
    if (mark > 0) return { mark };
  }
  return {};
}

/**
 * Pulls a position out of the model's reply. As with the marker reply a JSON object is what
 * is asked for, but a bare "412, 300" is just as usable an answer.
 */
export function parseWebAiPoint(
  reply: string,
): { x: number; y: number; what?: string } | undefined {
  // `Number(null)` and `Number("")` are both 0, so a model answering "not in view" the way
  // it was asked to would otherwise read as a click on the top-left corner of the page
  const ok = (x: unknown, y: unknown) => {
    for (const v of [x, y]) {
      if (v === null || v === undefined || v === "" || typeof v === "boolean") return undefined;
    }
    const px = Number(x);
    const py = Number(y);
    return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : undefined;
  };

  const obj = /\{[\s\S]*\}/.exec(reply);
  if (obj) {
    try {
      const parsed = JSON.parse(obj[0]) as { x?: unknown; y?: unknown; what?: unknown };
      const point = ok(parsed.x, parsed.y);
      if (point)
        return {
          ...point,
          ...(typeof parsed.what === "string" && parsed.what.trim()
            ? { what: parsed.what.trim().slice(0, 60) }
            : {}),
        };
    } catch {
      // fall through to the looser reads below
    }
  }
  const keyed = /\bx"?\s*[:=]\s*(-?\d+(?:\.\d+)?)[^\d-]+y"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i.exec(reply);
  if (keyed) return ok(keyed[1], keyed[2]);
  const pair = /(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/.exec(reply);
  if (pair) return ok(pair[1], pair[2]);
  return undefined;
}

type WebRect = { x: number; y: number; width: number; height: number };

/**
 * One look at the page: rule it, capture it (all of it, or the close-up window), take the
 * ruler off, and ask the model where the target is.
 *
 * Everything here is in CSS pixels, which is what the gridlines are labelled with and what
 * the mouse is aimed in. The screenshot may be larger than that on a scaled display, but
 * the model answers in the figures printed on the picture, so its own pixel count never
 * enters into it.
 */
async function locateWebPoint(
  page: Page,
  aiLocate: (image: string, prompt: string) => Promise<string>,
  prompt: string,
  gap: number,
  clip?: WebRect,
): Promise<{ reply: string; point?: { x: number; y: number; what?: string } }> {
  await drawWebGrid(page, gap, clip);
  const shot = await screenshotOf(page, 60, clip);
  await clearWebMarkBadges(page);
  if (!shot) throw new Error("the page could not be captured for the AI");
  const reply = (await aiLocate(shot, prompt)) ?? "";
  return { reply, point: parseWebAiPoint(reply) };
}

/** The close-up window around a first guess, kept inside the page. */
function refineWindow(at: { x: number; y: number }, view: { w: number; h: number }): WebRect {
  const width = Math.min(WEB_REFINE_PX, view.w);
  const height = Math.min(WEB_REFINE_PX, view.h);
  return {
    x: Math.round(Math.min(Math.max(at.x - width / 2, 0), view.w - width)),
    y: Math.round(Math.min(Math.max(at.y - height / 2, 0), view.h - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * Rings the position that was just clicked, so the screenshot kept for the step shows where
 * the pointer went rather than only what the page did about it. Green, to read apart from
 * the red measuring grid. Taken off again once that screenshot is captured.
 */
async function markClickPoint(page: Page, x: number, y: number): Promise<void> {
  await page
    .evaluate(
      ({ px, py }: { px: number; py: number }) => {
        const base = "position:fixed;pointer-events:none;z-index:2147483647;";
        const hair = `${base}background:#22c55e;box-shadow:0 0 0 1px rgba(255,255,255,.9);`;
        const holder = document.createElement("div");
        holder.className = "__bemby_mark";
        holder.innerHTML =
          `<div style="${base}left:${px - 13}px;top:${py - 13}px;width:26px;height:26px;` +
          `border:2px solid #22c55e;border-radius:50%;box-shadow:0 0 0 1px rgba(255,255,255,.9),inset 0 0 0 1px rgba(255,255,255,.9)"></div>` +
          `<div style="${hair}left:${px - 24}px;top:${py}px;width:48px;height:1px"></div>` +
          `<div style="${hair}left:${px}px;top:${py - 24}px;width:1px;height:48px"></div>` +
          `<div style="${base}left:${px + 16}px;top:${py + 16}px;color:#fff;background:#22c55e;` +
          `font:bold 11px/1.2 monospace;padding:2px 4px;border-radius:3px">clicked ${px},${py}</div>`;
        document.body.appendChild(holder);
      },
      { px: x, py: y },
    )
    .catch(() => {});
}

/** What is painted at a position, so the log can say what the click landed on. */
async function describePoint(page: Page, x: number, y: number): Promise<string> {
  return page
    .evaluate(
      ({ px, py }: { px: number; py: number }) => {
        const el = document.elementFromPoint(px, py) as HTMLElement | null;
        if (!el) return "nothing";
        const text = (el.innerText || el.getAttribute("aria-label") || el.title || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40);
        return text ? `<${el.tagName.toLowerCase()}> "${text}"` : `<${el.tagName.toLowerCase()}>`;
      },
      { px: x, py: y },
    )
    .catch(() => "something the page would not name");
}

/**
 * Types into whatever the last click focused, keystroke by keystroke.
 *
 * Deliberately not `page.type(selector, ...)`: that first waits for the element to pass
 * Playwright's actionability checks, which settle off animation-frame callbacks the
 * browser throttles when it believes its window is occluded -- exactly the state a
 * challenge page under Xvfb tends to be in. Keyboard events go to the focused element
 * regardless, which is what a person's typing does too.
 */
async function typeIntoFocused(page: Page, text: string): Promise<boolean> {
  let failed = false;
  await page.keyboard.type(text, { delay: 60 }).catch(() => {
    failed = true;
  });
  return !failed;
}

/** Types into the element carrying `data-bemby-mark=n`, or a plain CSS selector. */
async function typeInto(page: Page, selector: string, text: string): Promise<boolean> {
  if (!(await clickElement(page, selector))) return false;
  // Replace rather than append: a field a previous attempt filled would otherwise
  // end up with both values concatenated
  await page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) return;
      if (el.isContentEditable) el.textContent = "";
      else if (typeof el.value === "string") el.value = "";
    }, selector)
    .catch(() => {});
  return typeIntoFocused(page, text);
}

export type WebStepHooks = {
  /**
   * Hands a screenshot and a prompt to the vision model and returns its reply. Supplied by
   * the caller so the browser side stays clear of AI credentials and settings.
   */
  aiLocate?: (image: string, prompt: string) => Promise<string>;
};

/**
 * Runs the `open_url` sub-steps against the loaded page, capturing the page after each
 * one. Stops at the first step that cannot be carried out: the steps are usually a
 * sequence (type a name, type a password, press login), so carrying on past a failure
 * acts on a page that is not in the state the rest of them assume.
 */
export async function runWebSteps(
  page: Page,
  steps: WebStep[],
  deadline: number,
  hooks: WebStepHooks,
): Promise<{ logs: WebStepLog[]; ok: boolean; failure?: string }> {
  const tune = await cfTuning();
  const logs: WebStepLog[] = [];
  let failure: string | undefined;

  for (const step of steps) {
    if (msLeft(deadline) <= 0) {
      failure = "ran out of time before the page steps finished";
      break;
    }

    const log: WebStepLog = { type: step.type, label: describeWebStep(step) };
    logs.push(log);
    // Set when a step leaves something drawn on the page for its own screenshot to show
    let marked = false;

    // A challenge raised by the previous step (a login press is exactly what raises one)
    // leaves nothing of the site on screen for this one to act on
    if (step.type !== "web_delay" && (await interstitialOnPage(page))) {
      log.error = "a full-page Cloudflare challenge is covering the site";
      failure = `${log.label}: ${log.error}`;
      log.screenshot = await screenshotOf(page);
      break;
    }

    try {
      switch (step.type) {
        case "web_button": {
          const selector = step.selector.trim();
          if (!selector) throw new Error("no CSS selector given");
          if (!(await clickElement(page, selector)))
            throw new Error(`nothing matching \`${selector}\` is on the page`);
          log.outcome = `pressed \`${selector}\``;
          break;
        }

        case "web_input": {
          const selector = step.selector.trim();
          if (!selector) throw new Error("no CSS selector given");
          if (!(await typeInto(page, selector, step.text)))
            throw new Error(`nothing matching \`${selector}\` could be typed into`);
          log.outcome = `typed ${maskForLog(step.text, selector)} into \`${selector}\``;
          break;
        }

        case "web_delay": {
          const ms = Math.max(0, step.waitMs || 0);
          await sleep(ms, deadline);
          log.outcome = `waited ${Math.round(ms / 1000)}s`;
          break;
        }

        case "web_scroll": {
          const x = Math.round(step.x || 0);
          const y = Math.round(step.y || 0);
          if (!x && !y) throw new Error("no distance to scroll was given");
          // A page with nothing to scroll is not a failure: it may already fit on screen,
          // and the step that wanted the element will say so itself.
          log.outcome = (await scrollOutcome(page, x, y)) ?? "nothing on the page scrolls";
          break;
        }

        case "web_wait_element": {
          const selector = step.selector.trim();
          if (!selector) throw new Error("no CSS selector given");
          const waitMs = step.waitMs && step.waitMs > 0 ? step.waitMs : 30_000;
          const until = Math.min(Date.now() + waitMs, deadline);
          let seen = false;
          for (;;) {
            seen = await page
              .evaluate((sel: string) => {
                const el = document.querySelector(sel) as HTMLElement | null;
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              }, selector)
              .catch(() => false);
            if (seen || Date.now() >= until) break;
            // Nothing the site owns is on an interstitial, so waiting out the rest of the
            // timeout only delays the real answer -- and buries it under a step error
            // about a selector that was never going to appear.
            if (await interstitialOnPage(page)) {
              throw new Error(
                `a full-page Cloudflare challenge took over before \`${selector}\` appeared`,
              );
            }
            await sleep(Math.min(tune.readyPollMs, Math.max(50, until - Date.now())), until);
          }
          if (!seen)
            throw new Error(
              `\`${selector}\` did not appear within ${Math.round(waitMs / 1000)}s`,
            );
          log.outcome = `\`${selector}\` appeared`;
          break;
        }

        case "web_turnstile": {
          if (!(await clickTurnstileWidget(page)))
            throw new Error("no Turnstile widget is on the page");
          log.outcome = "pressed the Turnstile checkbox";
          break;
        }

        case "ai_web_button":
        case "ai_web_input": {
          if (!hooks.aiLocate) throw new Error("no AI model is configured for this step");
          const wantInput = step.type === "ai_web_input";
          const marks = await markWebElements(
            page,
            wantInput ? TYPEABLE_SELECTOR : CLICKABLE_SELECTOR,
            MAX_WEB_MARKS,
          );
          if (!marks.length) {
            await clearWebMarkBadges(page);
            throw new Error(
              wantInput
                ? "no field to type into is visible on the page"
                : "no control to press is visible on the page",
            );
          }
          // The model is shown the marked-up page; the clean shot is kept for the log
          const marked = await screenshotOf(page, 60);
          await clearWebMarkBadges(page);
          if (!marked) throw new Error("the page could not be captured for the AI");

          const wantText = wantInput && !step.text?.trim();
          const prompt = buildWebAiPrompt(step, marks, wantText);
          log.aiPrompt = prompt;
          const reply = await hooks.aiLocate(marked, prompt);
          log.aiResponse = reply;

          const { mark, text: aiText } = parseWebAiReply(reply ?? "");
          if (!mark) throw new Error(`the AI named no usable marker (replied "${oneLine(reply)}")`);
          const chosen = marks.find((m) => m.n === mark);
          if (!chosen) throw new Error(`the AI chose marker ${mark}, which is not on the page`);

          const selector = `[data-bemby-mark='${mark}']`;
          const what = chosen.text ? `<${chosen.tag}> "${chosen.text}"` : `<${chosen.tag}>`;

          if (!wantInput) {
            if (!(await clickElement(page, selector)))
              throw new Error(`marker ${mark} (${what}) has no on-screen box to press`);
            log.outcome = `AI pressed marker ${mark}, ${what}`;
            break;
          }

          const typed = step.text?.trim() ? step.text : aiText;
          if (!typed) throw new Error("the AI did not say what to type, and no text was configured");
          if (!(await typeInto(page, selector, typed)))
            throw new Error(`marker ${mark} (${what}) could not be typed into`);
          log.outcome = `AI typed ${maskForLog(typed, `${chosen.text} ${chosen.kind}`)} into marker ${mark}, ${what}`;
          break;
        }

        case "ai_web_click_xy": {
          if (!hooks.aiLocate) throw new Error("no AI model is configured for this step");
          const view = await page
            .evaluate(() => ({ w: innerWidth, h: innerHeight }))
            .catch(() => undefined);
          if (!view?.w || !view.h) throw new Error("the page size could not be read");

          // First look: the whole page, ruled coarsely. Enough to say which part of the
          // page the target is in, and reliably a few tens of pixels out on a small one.
          const wide = await locateWebPoint(
            page,
            hooks.aiLocate,
            buildWebPointPrompt(step.hint, view, WEB_GRID_PX),
            WEB_GRID_PX,
          );
          if (!wide.point)
            throw new Error(`the AI named no usable position (replied "${oneLine(wide.reply)}")`);
          if (
            wide.point.x < 0 ||
            wide.point.y < 0 ||
            wide.point.x > view.w ||
            wide.point.y > view.h
          )
            throw new Error(
              `the AI chose ${Math.round(wide.point.x)},${Math.round(wide.point.y)}, which is off a ${view.w}×${view.h} page`,
            );

          // Second look: a close-up around that answer, ruled finely, to correct it. The
          // window is clamped to the page, so a first guess near an edge still gets one.
          const window = refineWindow(wide.point, view);
          const refinePrompt = buildWebRefinePrompt(step.hint, window, WEB_REFINE_GRID_PX);
          const close = await locateWebPoint(
            page,
            hooks.aiLocate,
            refinePrompt,
            WEB_REFINE_GRID_PX,
            window,
          );
          log.aiPrompt = `${buildWebPointPrompt(step.hint, view, WEB_GRID_PX)}\n\n--- close-up pass ---\n\n${refinePrompt}`;
          log.aiResponse = `${wide.reply}\n\n--- close-up pass ---\n\n${close.reply}`;

          // A correction outside the window it was shown is not a correction, so the wide
          // answer stands rather than the click going somewhere nobody looked at
          const refined =
            close.point &&
            close.point.x >= window.x &&
            close.point.x <= window.x + window.width &&
            close.point.y >= window.y &&
            close.point.y <= window.y + window.height
              ? close.point
              : undefined;
          const aimed = refined ?? wide.point;
          const x = Math.round(aimed.x);
          const y = Math.round(aimed.y);

          // Read what is there before pressing it: a checkbox that swaps itself for a tick
          // the moment it is clicked would otherwise be logged as whatever replaced it
          const under = await describePoint(page, x, y);

          // Approach then press, as a pointer would -- the same shape as clickElement,
          // except nothing here resolves to an element to aim at
          let pointerFailure: string | undefined;
          await page.mouse.move(x - 8, y + 6).catch((err: any) => {
            pointerFailure = `move: ${err?.message ?? err}`;
          });
          await page.mouse.click(x, y).catch((err: any) => {
            pointerFailure = `click: ${err?.message ?? err}`;
          });
          if (pointerFailure) throw new Error(`the pointer could not be used (${pointerFailure})`);

          // Left on the page just long enough for this step's screenshot to catch it
          await markClickPoint(page, x, y);
          marked = true;

          // Spelled out, because "which pass decided this" is the first thing worth knowing
          // when a click lands somewhere unexpected
          const from = `${Math.round(wide.point.x)},${Math.round(wide.point.y)}`;
          const shift = !refined
            ? `the close-up could not see it, so the wide guess at ${from} stands`
            : x === Math.round(wide.point.x) && y === Math.round(wide.point.y)
              ? "the close-up agreed with the wide guess"
              : `the close-up moved it from ${from}`;
          const called = refined?.what ? `, which the AI called "${refined.what}"` : "";
          log.outcome = `AI clicked ${x},${y}, on ${under}${called} (${shift})`;
          break;
        }
      }
    } catch (err: any) {
      log.error = err?.message ?? String(err);
      failure = `${log.label}: ${log.error}`;
    }

    // The page as it stands after the step, whether it worked or not -- a failed step is
    // exactly the one whose screenshot is worth having
    await sleep(tune.inAppStepMs, deadline);
    if (logs.length <= MAX_WEB_SHOTS) log.screenshot = await screenshotOf(page);
    if (marked) await clearWebMarkBadges(page);
    if (failure) break;
  }

  // Let the last step's request round-trip before the page text is read
  if (logs.length) await sleep(tune.inAppSettleMs, deadline);
  return { logs, ok: !failure, failure };
}

/** What the step is trying to do, for the log line. */
function describeWebStep(step: WebStep): string {
  switch (step.type) {
    case "web_button":
      return `Press \`${step.selector}\``;
    case "web_input":
      return `Type into \`${step.selector}\``;
    case "web_delay":
      return `Wait ${Math.round((step.waitMs || 0) / 1000)}s`;
    case "web_scroll":
      return `Scroll ${Math.round(step.x || 0)},${Math.round(step.y || 0)}px`;
    case "web_wait_element":
      return `Wait for \`${step.selector}\``;
    case "web_turnstile":
      return "Press the Turnstile checkbox";
    case "ai_web_button":
      return `AI presses a control${step.hint?.trim() ? ` (${step.hint.trim()})` : ""}`;
    case "ai_web_input":
      return `AI fills a field${step.hint?.trim() ? ` (${step.hint.trim()})` : ""}`;
    case "ai_web_click_xy":
      return `AI clicks a position${step.hint?.trim() ? ` (${step.hint.trim()})` : ""}`;
  }
}

function buildWebAiPrompt(
  step: Extract<WebStep, { type: "ai_web_button" | "ai_web_input" }>,
  marks: WebMark[],
  wantText: boolean,
): string {
  const wantInput = step.type === "ai_web_input";
  const hint = step.hint?.trim();
  const noun = wantInput ? "text field" : "control";
  return [
    `The screenshot is a web page. Every ${noun} on it has been outlined in red and given a`,
    `number shown just above it. The numbered ${noun}s are:`,
    "",
    describeMarks(marks),
    "",
    hint
      ? `Choose the one that matches this description: ${hint}`
      : `Read the page and choose the one a person would use next to get through this page.`,
    "",
    wantText
      ? 'Reply with ONLY a JSON object: {"mark": <number>, "text": "<the text to type>"}. ' +
        "Work out the text from the page itself, for example the answer to a question it asks " +
        "or the characters shown in a captcha image."
      : 'Reply with ONLY a JSON object: {"mark": <number>}.',
    "No explanation, no code fences.",
  ].join("\n");
}

/** How the step names its target, for a prompt and for the log. */
function webPointTarget(hint: string | undefined): string {
  return hint?.trim() || "the control a person would press next to get through this page";
}

/**
 * The first, wide look. The grid is named so the model reads the figures off the lines
 * rather than estimating a fraction of the picture, and the labels are the coordinate
 * system asked for -- so a display that paints more device pixels than CSS ones cannot put
 * the answer in a different scale from the one the mouse works in.
 */
function buildWebPointPrompt(
  hint: string | undefined,
  view: { w: number; h: number },
  gap: number,
): string {
  return [
    `The screenshot is a web page, ${view.w} by ${view.h}. A red grid has been drawn over it`,
    `every ${gap} pixels, and the gridlines are labelled along the top and left edges with the`,
    `coordinates to answer in. The grid is an overlay for measuring only -- it is not part of`,
    `the page.`,
    "",
    `Find this and give the position at its centre: ${webPointTarget(hint)}`,
    "",
    `Read the position off the labelled gridlines: work out which lines it sits between, then`,
    `estimate within them. Aim for the middle of the target, not its edge or its label.`,
    "",
    'Reply with ONLY a JSON object: {"x": <number>, "y": <number>}, in the coordinates printed',
    "on the grid. No explanation, no code fences.",
  ].join("\n");
}

/**
 * The second, close look. The window is small enough that the same eyeballing lands within
 * a few pixels, and the labels still carry page coordinates, so the answer needs no
 * arithmetic against where the window was cut from.
 *
 * It is deliberately not told what the first pass answered. Told, models simply hand the
 * same figure back -- a run of this went out with an identical reply to both passes, and a
 * click 30px under the checkbox -- and a prompt that offers "repeat the earlier position"
 * as a way out gets taken up on it. Asking cold is what makes the second look a second
 * opinion. It has to name what it sees at the position for the same reason: a model that
 * must describe the thing it is pointing at cannot point at nothing.
 */
function buildWebRefinePrompt(hint: string | undefined, window: WebRect, gap: number): string {
  return [
    `The screenshot is a close-up of one part of a web page: the region from x=${window.x} to`,
    `x=${window.x + window.width}, y=${window.y} to y=${window.y + window.height}. A red grid`,
    `every ${gap} pixels is drawn over it, labelled with those same page coordinates. The grid`,
    `is an overlay for measuring only -- it is not part of the page.`,
    "",
    `Find this and give the position at its exact centre: ${webPointTarget(hint)}`,
    "",
    `Work it out from the labelled gridlines: which two lines it sits between on each axis,`,
    `then where between them. A checkbox is small -- aim at the middle of the box itself, not`,
    `at the words beside it and not at the edge of the panel holding it.`,
    "",
    'Reply with ONLY a JSON object: {"x": <number>, "y": <number>, "what": "<what is at that',
    'position>"}, in the page coordinates printed on the grid. If the target is not in this',
    'close-up at all, reply {"x": null, "y": null, "what": "not in view"}.',
    "No explanation, no code fences.",
  ].join("\n");
}

/**
 * Renders a typed value for the log, withheld when the field it went into looks like a
 * secret. Judged from the field (its selector, or how the AI described it) rather than the
 * value: a password does not contain the word "password", but the box it goes in usually does.
 */
function maskForLog(text: string, field: string): string {
  if (/pass|pwd|secret|token|otp|credential/i.test(field)) return "*** (hidden)";
  return `"${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`;
}

function oneLine(text: string | undefined): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 80)}…` : one;
}

/**
 * What a challenge actually looks at: the browser's own account of itself. Read in one
 * page so two installs (a dev machine and the container) can be compared line by line --
 * a missing GL stack or a browser with no fonts is invisible from the outside but reads
 * as automation from Cloudflare's side.
 */
const FINGERPRINT_PROBE = `(function () {
  var out = {};
  try {
    out.ua = navigator.userAgent;
    out.uaData = navigator.userAgentData
      ? navigator.userAgentData.brands.map(function (b) { return b.brand + " " + b.version; }).join(", ")
      : null;
    out.platform = navigator.platform;
    out.languages = (navigator.languages || []).join(",");
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    out.cores = navigator.hardwareConcurrency;
    out.memoryGb = navigator.deviceMemory || null;
    out.webdriver = navigator.webdriver;
    out.screen = screen.width + "x" + screen.height + "@" + window.devicePixelRatio;
    out.plugins = navigator.plugins.length;
  } catch (e) { out.navError = String(e); }

  // WebGL: a challenge reads the unmasked vendor/renderer. No GL stack at all is a
  // stronger signal than any UA string.
  try {
    var c = document.createElement("canvas");
    var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!gl) {
      out.webgl = "unavailable";
    } else {
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      out.webgl = dbg
        ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) + " / " + gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.VENDOR) + " / " + gl.getParameter(gl.RENDERER);
      out.webglVersion = gl.getParameter(gl.VERSION);
    }
    out.webgl2 = !!c.getContext("webgl2");
  } catch (e) { out.webgl = "error: " + e; }

  // Fonts, without fontconfig: a glyph the browser cannot draw measures the same as a
  // private-use character, so equal widths mean the font is missing (tofu).
  try {
    var cv = document.createElement("canvas").getContext("2d");
    var width = function (text, font) { cv.font = font; return cv.measureText(text).width; };
    var missing = width("\\uE000\\uE000", "16px sans-serif");
    out.latinOk = width("Bemby", "16px sans-serif") !== width("\\uE000\\uE000\\uE000\\uE000\\uE000", "16px sans-serif");
    out.cjkOk = width("\\u7B7E\\u5230", "16px sans-serif") !== missing;
    out.emojiOk = width("\\uD83C\\uDFAF", "16px sans-serif") !== width("\\uE000", "16px sans-serif");
    out.fontFamilies = ["sans-serif", "DejaVu Sans", "FreeSans", "Noto Sans CJK SC", "Noto Color Emoji"]
      .filter(function (f) { return document.fonts.check('16px "' + f + '"'); })
      .join(", ") || "none";
  } catch (e) { out.fontError = String(e); }

  return out;
})()`;

export type BrowserEnvReport = Record<string, unknown>;

/**
 * Reads the probe. `warnings` are things that stop the browser being useful or are a
 * direct automation tell; `notes` are differences worth seeing when comparing two
 * installs but which are not known to fail on their own -- a working setup passes
 * challenges with no GL stack at all, so that belongs in notes, not warnings.
 */
export function envReview(env: BrowserEnvReport): { warnings: string[]; notes: string[] } {
  const warnings: string[] = [];
  const notes: string[] = [];

  if (env.probeError) warnings.push(`The page could not be read: ${env.probeError}`);
  if (env.webdriver === true) {
    warnings.push("navigator.webdriver is true, which is a direct automation tell.");
  }
  if (env.latinOk === false) {
    warnings.push(
      "No usable fonts at all: fontconfig is finding none of the installed ones, so every " +
        "glyph is a box and text measures unlike any real browser.",
    );
  }
  if (typeof env.cores === "number" && env.cores <= 1) {
    warnings.push(`hardwareConcurrency is ${env.cores}: a real desktop reports more.`);
  }

  const webgl = String(env.webgl ?? "");
  if (!webgl || webgl === "unavailable" || webgl.startsWith("error")) {
    notes.push(
      "No WebGL. Worth comparing between installs, but not a blocker on its own: " +
        "challenges are passed on setups that report none.",
    );
  }
  if (env.webgl2 === false) notes.push("No WebGL2.");
  if (env.latinOk !== false && env.cjkOk === false) {
    notes.push("CJK glyphs are missing, so Chinese text renders as boxes (matching still works).");
  }
  if (env.emojiOk === false) notes.push("Emoji glyphs are missing.");
  if (env.uaData === null) {
    notes.push("No User-Agent Client Hints: expected off a secure origin, a real gap on one.");
  }
  return { warnings, notes };
}

/**
 * Launches the installed browser and checks that it actually renders: the same thing a
 * Mini App step depends on, told apart from a Cloudflare or network problem. Handy on a
 * server where the browser is an on-demand install and nothing else can be seen.
 * `env` reports what the page sees of itself, for comparing one install against another.
 */
export async function testBrowser(
  proxyUrl?: string,
  tier?: "keyed" | "free",
): Promise<{
  ok: boolean;
  /** Which build was exercised, when the caller asked for one in particular. */
  tier?: "keyed" | "free";
  executable?: string;
  version?: string;
  renderedText?: string;
  screenshot?: string;
  error?: string;
  env?: BrowserEnvReport;
  /** Things that stop the browser being useful, or read as automation outright. */
  warnings?: string[];
  /** Differences worth comparing between installs, none fatal on its own. */
  notes?: string[];
  /** Country the exit came out in, which also proves TLS and the proxy work. */
  exitCountry?: string;
}> {
  const executable = chromiumExecutable(tier);
  if (!executable) {
    return {
      ok: false,
      tier,
      error: tier
        ? `The ${tier === "keyed" ? "keyed" : "free"} build is not installed`
        : "Chromium is not installed",
    };
  }

  let launched: LaunchedBrowser | undefined;
  try {
    launched = await launchCfBrowser(proxyUrl, tier ? { tier } : {});
    const page = launched.page;
    const version = launched.context.browser()?.version() ?? chromiumVersion();
    await page.setContent("<h1 id=probe>bemby browser ok</h1>").catch(() => {});
    const renderedText = await page
      .evaluate(() => document.body?.innerText ?? "")
      .catch((err: any) => `evaluate failed: ${err?.message ?? err}`);
    // Read the fingerprint off a real https page: client hints and anything else gated on
    // a secure context do not exist on about:blank, and reporting them as absent there
    // would send someone chasing a difference that is only in the probe.
    let exitCountry: string | undefined;
    const secure = await page
      .goto(TRACE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (secure) {
      const trace = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      exitCountry = /(?:^|\n)loc=([A-Z]{2})/.exec(trace)?.[1];
    }
    const env = (await page.evaluate(FINGERPRINT_PROBE).catch((err: any) => ({
      probeError: err?.message ?? String(err),
    }))) as BrowserEnvReport;
    if (!secure) env.secureOrigin = false;
    const review = envReview(env);
    return {
      ok: typeof renderedText === "string" && renderedText.includes("bemby browser ok"),
      tier: tier ?? launched.tier,
      executable,
      version,
      env,
      exitCountry,
      warnings: review.warnings,
      notes: review.notes,
      renderedText,
      screenshot: await screenshotOf(page),
    };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const diagnosis = launchFailureReason(message);
    return {
      ok: false,
      tier,
      executable,
      // Chromium's whole stderr rides along on a launch failure; keep enough to work with
      error: message.length > 1200 ? `${message.slice(0, 1200)}…` : message,
      warnings: diagnosis ? [diagnosis] : undefined,
    };
  } finally {
    await launched?.close();
  }
}

/**
 * Names a launch failure whose cause is buried in the browser log it carries, so the panel
 * leads with something to act on rather than a wall of Chromium stderr.
 */
function launchFailureReason(message: string): string | undefined {
  if (/GLX is not present|EGL_NOT_INITIALIZED|ANGLE Display::initialize/i.test(message)) {
    return (
      "The browser could not start a GL display. This image ships no system GL, so the " +
      "browser has to run on its own bundled SwiftShader -- check the --use-gl=angle and " +
      "--use-angle=swiftshader launch flags are still in place, or reinstall the image."
    );
  }
  // The keyed build takes its licence at startup and quits on the spot if it cannot hold a
  // session -- before any page is opened, so the log is all startup noise and a signal.
  if (/SIGTRAP/.test(message) && /-pro\/chrome|licen[cs]e/i.test(message)) {
    return (
      "The licensed browser build quit during startup, before opening a page. It does that " +
      "when it cannot take a licence session: a free-plan key allows one browser at a time, " +
      "so check that no other instance is using the same key, that the key is still valid " +
      "in Settings, and that this host can reach the CloakBrowser licence service"
    );
  }
  if (/Failed to launch|ENOENT|no such file or directory/i.test(message)) {
    return "The browser binary could not be started. Re-download it from this panel.";
  }
  return undefined;
}

/**
 * JPEG of what the browser is looking at, small enough to keep in a job log. `clip` narrows
 * it to one region, for the close-up the `ai_web_click_xy` step takes.
 */
async function screenshotOf(
  page: Page,
  quality = 45,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<string | undefined> {
  const buffer = await page
    .screenshot({ type: "jpeg", quality, ...(clip ? { clip } : {}) })
    .catch(() => undefined);
  const shot = buffer?.toString("base64");
  if (!shot) return undefined;
  // Job logs are stored as JSON in SQLite; an oversized image is not worth keeping
  if (shot.length > 700_000) return undefined;
  return `data:image/jpeg;base64,${shot}`;
}

/** One load-and-solve pass through a single exit (the proxy, or direct). */
async function attemptLoad(
  url: string,
  proxyUrl: string | undefined,
  opts: LoadOptions,
  budgetDeadline: number,
): Promise<CheckinPageResult> {
  const tune = await cfTuning();
  const finalHost = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  })();
  let launched: LaunchedBrowser | undefined;
  // Tells a browser that never started from one that started and then hit trouble: only
  // the latter says anything about the exit.
  let launchOk = false;
  let browserTier: "keyed" | "free" | undefined;
  // Renderer trouble the page reports on its own: a crashed tab or a main request
  // that never arrived both leave a blank page that otherwise looks challenge-free.
  const troubles: string[] = [];
  const note = (msg: string) => {
    // A challenge page aborts its own load on the way to the destination, so an
    // aborted request says nothing about whether the page came up
    if (/ERR_ABORTED/i.test(msg)) return;
    if (troubles.length < 5 && !troubles.includes(msg)) troubles.push(msg);
  };
  try {
    // The clock and language of the exit are launch flags, so this settles them before
    // anything on the target is loaded
    launched = await launchAlignedBrowser(proxyUrl, budgetDeadline);
    launchOk = true;
    browserTier = launched.tier;
    const page = launched.page;

    page.on("crash", () => note("page crashed"));
    page.on("pageerror", (err: Error) => note(`page script error: ${err?.message ?? err}`));
    page.on("requestfailed", (req) => {
      if (req.isNavigationRequest()) note(`request failed: ${req.failure()?.errorText}`);
    });

    // In dev the backend runs via tsx/esbuild, which wraps functions passed to
    // page.evaluate() with a __name() helper that doesn't exist in the browser.
    // Shim it (string form, so this injection itself isn't instrumented) so the
    // evaluate() calls below work under tsx too; tsc production builds don't need it.
    await page
      .addInitScript("window.__name = window.__name || function (a) { return a; };")
      .catch(() => {});

    if (opts.miniApp) {
      await page.addInitScript(WEBVIEW_PROXY_SHIM).catch(() => {});
    }

    await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(5_000, capped(tune.navTimeoutMs, budgetDeadline)),
      })
      .catch((err: any) => {
        // The challenge page may abort/redirect mid-load; the poll below is the
        // real signal, so a goto rejection isn't fatal -- but it is recorded, since
        // a page that never loaded looks exactly like one with no challenge on it.
        note(`navigation: ${err?.message ?? err}`);
      });

    // Compare without the fragment: a Mini App rewriting its hash route is not the
    // portal navigating away, and counting it would call the challenge solved at once.
    const withoutHash = (u: string) => u.split("#")[0];
    const startUrl = withoutHash(page.url());
    await waitForPageReady(page, budgetDeadline);

    // Works a challenge that is on the page right now. Returns null when there is
    // none, so callers can tell "nothing to do" from "tried and failed".
    const solveChallenge = async (): Promise<boolean | null> => {
      const interstitial = await isInterstitial(page);
      let widget = await hasTurnstileWidget(page);

      // Not every app uses Turnstile: a Cap checkbox is solved in the browser instead.
      if (!interstitial && !widget && (await hasCapWidget(page))) {
        return solveCap(page, Math.min(Date.now() + tune.challengeTimeoutMs, budgetDeadline));
      }

      // A verify portal may load the Turnstile script and only render the widget once
      // its single button is pressed, so try that before concluding there is nothing.
      if (!interstitial && !widget && (await hasTurnstileScript(page))) {
        if (await clickVerifyButton(page)) {
          for (let i = 0; i < 6 && !widget; i++) {
            await sleep(tune.readyPollMs, budgetDeadline);
            widget = await hasTurnstileWidget(page);
          }
        }
      }
      if (!interstitial && !widget) return null;

      // Custom verify portals only engage Turnstile after a real click.
      if (widget) await clickVerifyButton(page);

      const challengeStart = Date.now();
      const deadline = Math.min(challengeStart + tune.challengeTimeoutMs, budgetDeadline);
      let widgetClicks = 0;
      while (Date.now() < deadline) {
        await sleep(tune.pollMs, deadline);
        if (turnstilePassed(await turnstileToken(page), await isInterstitial(page))) return true;
        // Nudge a widget that is sitting there unsolved: it may be an interactive
        // checkbox that nothing has clicked yet. Spaced out, so a widget that is
        // verifying on its own is not interrupted.
        if (widget && widgetClicks < 3 && Date.now() > challengeStart + (widgetClicks + 1) * 4_000) {
          widgetClicks++;
          await clickTurnstileWidget(page);
        }
        const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        // The site has already rejected this exit; waiting the rest out gains nothing
        if (REFUSED_RE.test(body)) return false;
        // Nothing below means anything while the interstitial is still up: a managed
        // challenge navigates to its own URL to run, so the address changing is the
        // challenge working, not the portal letting us through.
        if (await isInterstitial(page)) continue;
        // A challenge that cleared and left no widget behind is done -- but mid-reload
        // the document has no title and no widget in it either, which reads exactly the
        // same, so it has to still be gone one poll later before this counts.
        if (await challengeGone(page)) {
          await sleep(tune.pollMs, deadline);
          if (await challengeGone(page)) return true;
          continue;
        }
        // Portal navigated away or shows a success message.
        if (withoutHash(page.url()) !== startUrl) return true;
        if (SUCCESS_RE.test(body)) return true;
      }
      return false;
    };

    // The challenge may be up already, or an app may only raise it once a provider or
    // action is chosen inside it -- so try before the in-app steps and again after.
    const before = await solveChallenge();
    let solved = before ?? true;
    let challenged = before !== null;

    // Some apps render their own "verification failed" instead of a challenge widget
    if (solved) {
      const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (REFUSED_RE.test(body)) {
        solved = false;
        challenged = true;
      }
    }

    await sleep(tune.settleMs, budgetDeadline);

    // A plain page is driven by its own typed sub-steps rather than the Mini App's
    // label-matching, and the challenge is worked again afterwards: pressing a login or
    // submit control is exactly what makes a site raise one.
    let webSteps: WebStepLog[] | undefined;
    let webFailure: string | undefined;
    if (opts.webSteps?.length && solved) {
      const run = await runWebSteps(page, opts.webSteps, budgetDeadline, {
        aiLocate: opts.aiLocate,
      });
      webSteps = run.logs;
      webFailure = run.failure;

      const after = await solveChallenge();
      if (after !== null) {
        challenged = true;
        solved = after;
      }
    }

    // A Mini App checkin is a tap inside the app, not the page load itself.
    let inAppAction: string | undefined;
    let inAppFailure: string | undefined;
    // Whether any of those steps actually acted on the app, as opposed to only waiting or
    // scrolling into position.
    let inAppActed = false;
    // Standing text, captured before the steps run, so a verify prompt the page has always
    // shown can be told from one raised by pressing the control.
    let priorText: string | undefined;
    if (opts.miniApp && solved) {
      priorText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      const clicks = await runInAppClicks(
        page,
        opts.inAppClicks ?? [],
        budgetDeadline,
        opts.solveQuestion,
        opts.aiLocate,
      );
      inAppAction = clicks.trace;
      inAppFailure = clicks.failure;
      inAppActed = clicks.acted;

      // A verification the app raises only once the checkin is pressed needs a moment to
      // render. Asking once, immediately, sees nothing there and calls the step done --
      // so while the app says it wants one, keep looking for it.
      const challengeBy = Math.min(Date.now() + tune.postClickChallengeMs, budgetDeadline);
      let after: boolean | null = null;
      for (;;) {
        after = await solveChallenge();
        if (after !== null) break;
        const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        // Standing wording is not the app asking; waiting it out just spends the budget.
        if (!VERIFY_REQUIRED_RE.test(body) || !isLivePrompt(body, priorText)) break;
        if (Date.now() >= challengeBy) break;
        await sleep(tune.pollMs, challengeBy);
      }
      if (after !== null) {
        challenged = true;
        solved = after;
      }
    }

    // A widget-based challenge is verified server-side after the token is issued, so
    // the app's own wording is the outcome. Give it a bounded wait rather than closing
    // the browser while the request is still in flight.
    let text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (solved && challenged && !SUCCESS_RE.test(text)) {
      const deadline = Math.min(Date.now() + tune.confirmTimeoutMs, budgetDeadline);
      while (Date.now() < deadline) {
        await sleep(tune.pollMs, deadline);
        text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        if (SUCCESS_RE.test(text)) break;
      }
    }

    const pageTitle = (await page.title().catch(() => "")) || undefined;
    const navError = troubles.length ? troubles.join("; ") : undefined;

    const verdict = opts.miniApp
      ? await miniAppVerdict({
          challenged,
          solved,
          text,
          inAppAction,
          inAppActed,
          inAppFailure,
          navError,
          priorText,
        })
      : webSteps
        ? // A sub-step that could not be carried out is a failure even with no challenge in
          // the way: the page was never driven to where the caller wanted it.
          { ok: solved && !webFailure, reason: solved ? webFailure : challengeRefused(challenged, navError) }
        : { ok: solved, reason: solved ? undefined : challengeRefused(challenged, navError) };

    return {
      ok: verdict.ok,
      challenged,
      text,
      finalHost,
      inAppAction,
      webSteps,
      reason: verdict.reason,
      navError,
      pageTitle,
      // A challenge this exit was refused, or a page it never loaded, is worth retrying
      // elsewhere; a control that is not on the page is not. A sub-step that failed once
      // the challenge was already cleared is the page's doing, so every other exit would
      // meet it alike -- rotating the pool there only spends the budget.
      browserTier,
      exitRelated: solved && webFailure ? false : !!navError || (challenged && !verdict.ok) || !text.trim(),
      screenshot: opts.screenshot ? await screenshotOf(page) : undefined,
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (/not installed|executablePath|ENOENT|Could not find|Failed to launch/i.test(msg)) {
      console.error(`[cloudflare] Chromium not available: ${msg}`);
    } else {
      console.error(`[cloudflare] Failed to load ${finalHost}: ${msg}`);
    }
    // A browser that never started is not the exit's doing, and no other exit can fix it
    if (!launchOk) {
      return {
        ok: false,
        challenged: false,
        text: "",
        finalHost,
        reason: `${launchFailureReason(msg) ?? "the solver browser could not be started"} (${oneLine(msg).slice(0, 200)})`,
        navError: msg,
        exitRelated: false,
        browserFailed: true,
      };
    }
    return {
      ok: false,
      challenged: false,
      text: "",
      finalHost,
      reason: msg,
      navError: msg,
      browserTier,
      exitRelated: true,
    };
  } finally {
    await launched?.close();
  }
}

/**
 * Load `url` in the installed Chromium, pass any Cloudflare challenge (full-page
 * interstitial or embedded Turnstile widget), and return the final page's visible
 * text so the caller can match success/fail keywords.
 *
 * Cloudflare judges the exit IP as much as the browser, so when the caller offers a pool
 * of proxies (`opts.proxyCandidates`) each is tried until one is accepted. Only a refused
 * challenge moves on to the next -- a page that loads with no challenge, or one that
 * clears it, is done. `opts.refreshUrl` re-mints the address between attempts, which a
 * signed Mini App URL needs since its init data ages.
 *
 * `opts.maxWaitMs` bounds the whole thing: exits are tried only while budget remains,
 * so a hunt through a large pool cannot run for an unbounded stretch.
 */
export async function loadCheckinUrl(
  url: string,
  proxyUrl?: string,
  opts: LoadOptions = {},
): Promise<CheckinPageResult> {
  const tune = await cfTuning();
  const candidates: ProxyCandidate[] = opts.proxyCandidates?.length
    ? opts.proxyCandidates
    : [{ id: proxyUrl ? "job" : "direct", label: proxyUrl ? "job proxy" : "direct", url: proxyUrl }];

  const budget = opts.maxWaitMs && opts.maxWaitMs > 0 ? opts.maxWaitMs : tune.budgetMs;
  const deadline = Date.now() + budget;

  let target = url;
  let last: CheckinPageResult | undefined;
  const trace: string[] = [];
  const refusedProxyIds: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (i > 0) {
      if (msLeft(deadline) < tune.minAttemptMs) {
        trace.push(`out of time after ${i} exit(s) (budget ${Math.round(budget / 1000)}s)`);
        console.log(`[cloudflare] budget spent after ${i} exit(s), giving up`);
        break;
      }
      console.log(
        `[cloudflare] challenge refused, retrying via ${candidate.label} (${i + 1}/${candidates.length})`,
      );
      // A signed Mini App URL ages, so mint a fresh one for this attempt when possible
      if (opts.refreshUrl) {
        const fresh = await opts.refreshUrl().catch(() => undefined);
        if (fresh) target = fresh;
      }
    }

    const result = await attemptLoad(target, candidate.url, opts, deadline);
    // Only a failure the exit had a hand in counts against it. A browser that never
    // started, or an app that simply does not have the control being looked for, is the
    // same through every exit -- marking them refused empties the pool over something no
    // proxy was ever going to fix, and the next attempt then reports "every proxy refused"
    // in place of the real fault.
    const exitAtFault = !result.ok && !result.browserFailed && result.exitRelated !== false;
    if (exitAtFault) refusedProxyIds.push(candidate.id);
    trace.push(
      [
        `${candidate.label}: ${result.ok ? "ok" : "failed"}`,
        result.challenged ? "challenged" : undefined,
        result.pageTitle ? `title="${result.pageTitle}"` : undefined,
        `text ${result.text.trim().length} chars`,
        result.inAppAction ? `in-app: ${result.inAppAction}` : undefined,
        result.webSteps?.length
          ? `page steps: ${result.webSteps.map((s) => s.outcome ?? `${s.label} FAILED`).join(" → ")}`
          : undefined,
        result.reason,
      ]
        .filter(Boolean)
        .join(" | "),
    );
    last = {
      ...result,
      proxyId: candidate.id,
      proxyLabel: candidate.label,
      attempts: i + 1,
      trace: [...trace],
      refusedProxyIds: [...refusedProxyIds],
    };
    if (result.ok) return last;

    // The browser is what failed; working through the pool would only repeat it
    if (result.browserFailed) {
      trace.push("the solver browser could not start, so no exit was tried");
      console.error("[cloudflare] the solver browser could not start; leaving the pool alone");
      break;
    }

    // Nothing another exit can do about a failure inside the app itself
    if (result.exitRelated === false) {
      trace.push("failed inside the app, so no other exit was tried");
      console.log("[cloudflare] failure is not about the exit; leaving the rest of the pool alone");
      break;
    }
  }

  return { ...last!, trace: [...trace], refusedProxyIds: [...refusedProxyIds] };
}
