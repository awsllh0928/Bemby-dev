import { Router } from "express";
import { col } from "../db/collection";
import {
  allSettings,
  getSetting,
  setSetting,
  setSettings,
} from "../db/repos/settings";
import type { SettingDoc } from "../db/types";
import { refreshScheduler, purgeOldLogs } from "../scheduler";
import { SocksClient } from "socks";
import { parseTgProxy } from "../jobs/runner";
import { isBulkAccountManagementEnabled } from "../jobs/bulkAdd";
import {
  areCfFontsInstalled,
  cfFontsStatus,
  chromiumVersion,
  installCfChromium,
  installCfFonts,
  isChromiumInstalled,
  testBrowser,
} from "../jobs/cloudflare";
import {
  CF_TUNING_DEFAULTS,
  CF_TUNING_KEY,
  CF_TUNING_LIMITS,
  cfTuning,
  invalidateCfTuning,
  resolveCfTuning,
} from "../jobs/cfTuning";
import {
  CF_KEYS_SETTING,
  cfLicenseKeys,
  cfLicenseKeysForClient,
  cfLicenseUsage,
  maskKey,
  saveCfLicenseKeys,
} from "../jobs/cfLicense";
import {
  cfBrowsersRunning,
  cfProfileCount,
  checkCfLicenseKey,
  clearCfProfiles,
  chromiumExecutable,
  chromiumPath,
  CF_BROWSER_LANG_KEY,
  installedBuildTier,
  installedCfBuilds,
  keyedBuildPending,
  removeAllCfBuilds,
  stopAllCfBrowsers,
} from "../jobs/cfBrowser";
import {
  providersForClient,
  saveProviders,
  syncProviders,
  type ProxyProvider,
} from "../tg/proxyProviders";
import {
  getBotInfo,
  getNotifyConfig,
  maskBotToken,
  NOTIFY_BOT_TARGET_KEY,
  NOTIFY_BOT_TOKEN_KEY,
  recentBotChats,
  sendBotNotify,
} from "../jobs/notify";

const router = Router();

export const ALLOWED_KEYS = [
  "default_timezone",
  "default_max_retry",
  "check_daily_run",
  "default_ua",
  "default_play_duration",
  "default_device_name",
  "ai_model",
  "ai_default_model_id",
  "ai_fallback_enabled",
  // Deprecated: target for the account-session sender, kept until that sender is removed
  "notify_tg_username",
  "notify_tg_events",
  NOTIFY_BOT_TOKEN_KEY,
  NOTIFY_BOT_TARGET_KEY,
  "ua_presets",
  "proxies",
  "tg_app_clients",
  "tg_client_mode",
  "default_tg_api_id",
  "default_tg_api_hash",
  "account_display_with_tg_name",
  "schedule_separate_page",
  "log_retention_days",
  "schedule_min_gap_minutes",
  "cf_solver_enabled",
  CF_BROWSER_LANG_KEY,
  CF_TUNING_KEY,
];

/** Settings keys that must never be sent to the client. */
export const CLIENT_HIDDEN_KEYS = new Set([
  "admin_password_hash",
  "admin_username",
  "jwt_secret",
  // Legacy single-key AI credential (superseded by the ai_suppliers table);
  // never echo it back to the client on upgraded installs.
  "ai_api_key",
  // CloakBrowser licence keys: served separately, masked
  CF_KEYS_SETTING,
  // Proxy provider credentials: served separately, with keys replaced by a flag
  "webshare_api_key",
  "proxy_providers",
  // Notification bot token: served masked, under a separate key
  NOTIFY_BOT_TOKEN_KEY,
]);

/** True when an AI key exists anywhere the runtime looks: a supplier, the legacy setting or the env. */
async function aiKeyConfigured(): Promise<boolean> {
  const suppliers = await col("ai_suppliers").countDocuments({ api_key: { $ne: "" } });
  if (suppliers > 0) return true;
  const legacy = await getSetting("ai_api_key");
  return Boolean(legacy || process.env.AI_API_KEY);
}

/** Returns first 4 chars + **** + last 4 chars, or **** for short values. */
function maskApiHash(hash: string): string {
  if (!hash) return "";
  if (hash.length <= 8) return "****";
  return `${hash.slice(0, 4)}****${hash.slice(-4)}`;
}

// A proxy is stored as a URL with its credentials inside it, so sending the list to the
// client sent the passwords with it -- while the seller's API key beside it was already held
// back. The password is replaced by this sentinel on the way out and restored on the way
// back in, the same round trip the API hash above already makes.
export const PROXY_PASSWORD_MASK = "********";

type ProxyEntry = { id?: string; url?: string; [key: string]: unknown };

function parseProxyList(raw: string | undefined): ProxyEntry[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as ProxyEntry[]) : [];
  } catch {
    return [];
  }
}

/** Rewrites a proxy URL's password, leaving everything else about it intact. */
function withProxyPassword(url: string, password: string | null): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    if (password === null) return url;
    parsed.password = password;
    return parsed.toString();
  } catch {
    return url;
  }
}

function proxyPassword(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
}

/** The proxies setting with every password replaced by the sentinel. */
export function maskProxies(raw: string | undefined): string {
  const list = parseProxyList(raw);
  if (!list.length) return raw ?? "[]";
  return JSON.stringify(
    list.map((p) =>
      typeof p.url === "string" && proxyPassword(p.url)
        ? { ...p, url: withProxyPassword(p.url, PROXY_PASSWORD_MASK) }
        : p,
    ),
  );
}

/**
 * Puts the real passwords back where the client sent the sentinel unchanged. An entry whose
 * id is not already stored has nothing to restore from, so its value is taken at face value.
 */
export function unmaskProxies(incoming: string, storedRaw: string | undefined): string {
  const list = parseProxyList(incoming);
  if (!list.length) return incoming;
  const stored = new Map(
    parseProxyList(storedRaw)
      .filter((p) => typeof p.id === "string" && typeof p.url === "string")
      .map((p) => [p.id as string, p.url as string]),
  );
  return JSON.stringify(
    list.map((p) => {
      if (typeof p.url !== "string" || proxyPassword(p.url) !== PROXY_PASSWORD_MASK) return p;
      const previous = typeof p.id === "string" ? stored.get(p.id) : undefined;
      const password = previous ? proxyPassword(previous) : "";
      return { ...p, url: withProxyPassword(p.url, password) };
    }),
  );
}

/** Returns client-safe settings: migration flags and secret keys removed, API hash masked. */
async function getClientSettings(): Promise<Record<string, string>> {
  const rows = await col<SettingDoc>("settings").find({}).toArray();
  // Migration flags are bookkeeping, never something to hand to the client. SQLite excluded
  // them with `key NOT LIKE 'migration:%'`; here they are dropped after the read.
  const result = Object.fromEntries(
    rows
      .filter(
        (r) => !String(r._id).startsWith("migration:") && !CLIENT_HIDDEN_KEYS.has(String(r._id)),
      )
      .map((r) => [String(r._id), r.value]),
  );
  // Never expose the raw hash to the client
  if (result.default_tg_api_hash) {
    result.default_tg_api_hash = maskApiHash(result.default_tg_api_hash);
  }
  // Nor the passwords sitting inside the proxy URLs
  if (result.proxies) {
    result.proxies = maskProxies(result.proxies);
  }
  // Synthetic flag so the client can gate AI features without seeing the key
  result.ai_key_configured = (await aiKeyConfigured()) ? "true" : "false";
  // Env-gated feature flag for bulk account management (add + clean)
  result.bulk_account_management = isBulkAccountManagementEnabled()
    ? "true"
    : "false";
  // Whether the on-demand Cloudflare-solver browser is present, and which build
  result.cf_chromium_installed = isChromiumInstalled() ? "true" : "false";
  result.cf_chromium_version = chromiumVersion() ?? "";
  // Which build is on disk, and whether a configured key unlocks one that is not yet
  // downloaded -- downloads are deliberate, so this is what surfaces the outstanding one
  result.cf_chromium_tier = installedBuildTier() ?? "";
  result.cf_chromium_path = chromiumPath() ?? "";
  result.cf_chromium_keyed_pending = (await keyedBuildPending()) ? "true" : "false";
  // Whether the unlicensed build is also on disk. It is what a launch falls back to when
  // no licence seat is free -- without it, such a launch has nothing that can run.
  result.cf_chromium_free_installed = chromiumExecutable("free") ? "true" : "false";
  // Every build on disk, so the panel can list the keyed and free ones side by side
  result.cf_chromium_builds = JSON.stringify(installedCfBuilds());
  // Browser profiles on disk: state carried between runs, and the thing to clear when a
  // browser starts failing for no reason that changed elsewhere
  result.cf_profile_count = String(cfProfileCount());
  // How many solver browsers are open right now, so the panel can offer to stop them
  result.cf_browsers_running = String(cfBrowsersRunning());
  // The CJK/emoji faces are not in the image either; they sit beside the browser in the
  // data dir. Reported separately so a browser that can only draw Latin is visible.
  result.cf_fonts_installed = areCfFontsInstalled() ? "true" : "false";
  result.cf_fonts_missing = cfFontsStatus().missing.join(", ");
  // Licence keys, masked, plus how many seats are taken right now: a free key is one
  // concurrent session, so the count is what tells the operator whether to add another
  result.cf_cloak_keys_masked = JSON.stringify(await cfLicenseKeysForClient());
  result.cf_cloak_keys_in_use = String((await cfLicenseUsage()).inUse);
  // The browser timings in force, alongside the shipped defaults and the range each is
  // held to, so the client can render every field without a second source of truth
  result.cf_tuning = JSON.stringify(await cfTuning());
  result.cf_tuning_defaults = JSON.stringify(CF_TUNING_DEFAULTS);
  result.cf_tuning_limits = JSON.stringify(CF_TUNING_LIMITS);
  // Synthetic count so the client can show whether proxy importing is set up
  result.proxy_providers_count = String((await providersForClient()).length);
  // The notification bot's token, masked. Its presence is what decides whether job
  // notifications go out as the bot or fall back to the job's own account session.
  const botToken = (await getNotifyConfig()).botToken;
  result.notify_bot_configured = botToken ? "true" : "false";
  result.notify_bot_token_masked = botToken ? maskBotToken(botToken) : "";
  return result;
}

router.get("/", async (_req, res) => {
  try {
    res.json(await getClientSettings());
  } catch (e) {
    console.error("[settings] read failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/", async (req, res) => {
  const updates = req.body as Record<string, string>;

  try {
  // Collected and written in one pass rather than key by key: Mongo transactions need a
  // replica set, so a bulk write is the closest thing to SQLite's single-transaction PUT
  // that works on a standalone server too.
  const writes: Record<string, string> = {};
  {
    for (const key of ALLOWED_KEYS) {
      if (!(key in updates)) continue;
      // Skip if the client sent back the masked hash or bot token unchanged
      if (
        (key === "default_tg_api_hash" || key === NOTIFY_BOT_TOKEN_KEY) &&
        String(updates[key]).includes("****")
      )
        continue;
      // Put back any proxy password the client echoed as the mask rather than retyping
      if (key === "proxies") {
        const current = await getSetting("proxies");
        writes[key] = unmaskProxies(String(updates[key]), current);
        continue;
      }
      // Browser timings are stored resolved: out-of-range or unparsable values become the
      // shipped default there and then, so what is saved is what a job will use
      if (key === CF_TUNING_KEY) {
        let incoming: unknown = updates[key];
        if (typeof incoming === "string") {
          try {
            incoming = JSON.parse(incoming);
          } catch {
            incoming = undefined;
          }
        }
        writes[key] = JSON.stringify(resolveCfTuning(incoming));
        continue;
      }
      writes[key] = String(updates[key]);
    }
  }
  await setSettings(writes);

  // Reschedule if daily-run check toggled or the default timezone changed
  // (jobs with no timezone of their own follow the default)
  if ("check_daily_run" in updates || "default_timezone" in updates)
    refreshScheduler();

  // Apply a tightened retention window straight away
  if ("log_retention_days" in updates) void purgeOldLogs();

  // Drop the cached timings so the next job picks the new ones up without a restart
  if (CF_TUNING_KEY in updates) invalidateCfTuning();

  res.json(await getClientSettings());
  } catch (e) {
    console.error("[settings] save failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /cf-solver/install -- download the CloakBrowser stealth Chromium (~200MB) and the
// CJK/emoji faces (~30MB) on demand into the data dir so the Cloudflare "I am not a bot"
// solver can run. Neither is in the image, and the data dir is a volume, so both survive an
// upgrade. `force` downloads again over an existing install, which is how they get updated.
//
// The fonts are reported but do not decide `ok`: with the image's Latin fallback the
// browser still works, so a blocked font download is a warning, not a failed install.
let cfInstalling = false;
router.post("/cf-solver/install", async (req, res) => {
  const force = req.body?.force === true || req.query.force === "1";
  // "free" asks for the unlicensed build specifically, which is what a launch falls back
  // to when no licence seat is free. It is a separate download, so an install that already
  // has the keyed build still has work to do.
  const tier = req.body?.tier === "free" ? ("free" as const) : undefined;
  if (tier === "free") {
    if (cfInstalling) {
      res.status(409).json({ ok: false, message: "Install already in progress" });
      return;
    }
    cfInstalling = true;
    try {
      const browser = await installCfChromium(force, "free");
      res.json({
        ok: browser.ok,
        installed: browser.ok,
        fontsInstalled: areCfFontsInstalled(),
        version: browser.ok ? chromiumVersion() : undefined,
        output: browser.output.slice(-1500),
      });
    } finally {
      cfInstalling = false;
    }
    return;
  }
  // A licence key with no build behind it counts as outstanding: the key is only worth
  // anything once the build it unlocks is on disk.
  if (isChromiumInstalled() && areCfFontsInstalled() && !keyedBuildPending() && !force) {
    res.json({
      ok: true,
      installed: true,
      fontsInstalled: true,
      version: chromiumVersion(),
      message: "Already installed",
    });
    return;
  }
  if (cfInstalling) {
    res.status(409).json({ ok: false, message: "Install already in progress" });
    return;
  }
  cfInstalling = true;
  try {
    // Only re-download a browser that is missing (or explicitly forced): an upgrade from an
    // image that carried the fonts needs the fonts alone, not another 200MB of browser.
    const browser = isChromiumInstalled() && !keyedBuildPending() && !force
      ? { ok: true, output: "Browser already installed" }
      : await installCfChromium(force);
    const fonts = await installCfFonts(force);
    if (browser.ok) {
      await setSetting("cf_solver_enabled", "true");
    }
    res.json({
      ok: browser.ok,
      installed: browser.ok,
      fontsInstalled: fonts.ok,
      version: browser.ok ? chromiumVersion() : undefined,
      output: `${browser.output}\n\n--- fonts ---\n${fonts.output}`.slice(-1500),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message ?? "Install failed" });
  } finally {
    cfInstalling = false;
  }
});

// ── CloakBrowser licence keys ─────────────────────────────────────────────────
// A free key (one per GitHub sign-in at cloakbrowser.dev/free) gets the current stealth
// build instead of the ageing one that needs no key, and allows one concurrent browser.
// Several can be stored so concurrent jobs each get a seat. Never sent back in full.

router.get("/cf-solver/keys", (_req, res) => {
  res.json({ keys: cfLicenseKeysForClient(), ...cfLicenseUsage() });
});

router.put("/cf-solver/keys", (req, res) => {
  const { keys } = req.body as { keys?: Array<{ label?: string; key?: string }> };
  if (!Array.isArray(keys)) {
    res.status(400).json({ error: "keys array is required" });
    return;
  }
  saveCfLicenseKeys(keys);
  res.json({ keys: cfLicenseKeysForClient(), ...cfLicenseUsage() });
});

// POST /cf-solver/keys/check -- ask CloakBrowser's server what each stored key is worth,
// so a key that was mistyped or has lapsed shows up here rather than as a job that quietly
// runs the old build.
router.post("/cf-solver/keys/check", async (_req, res) => {
  const results = [];
  for (const entry of await cfLicenseKeys()) {
    results.push({ label: entry.label, masked: maskKey(entry.key), ...(await checkCfLicenseKey(entry.key)) });
  }
  res.json({ results });
});

// POST /cf-solver/test -- launch the installed browser and check that it renders, so a
// Mini App step that comes up blank on a server can be told apart from a site problem.
// `?screenshot=1` includes what the browser drew.
// POST /cf-solver/stop -- close every solver browser that is open. The jobs holding them
// fail as their pages go; that is the point, since this is the way out when a run has
// wedged and is sitting on a licence seat, a profile or a proxy nothing else can have.
router.post("/cf-solver/stop", async (_req, res) => {
  const result = await stopAllCfBrowsers();
  res.json({ ok: true, stopped: result.stopped });
});

// POST /cf-solver/clear-profiles -- delete the per-exit browser profiles (cookies, cache,
// site data). Nothing identifying goes with them: the fingerprint is derived from the exit,
// not stored here. Refused while a browser still has one open.
router.post("/cf-solver/clear-profiles", (_req, res) => {
  const result = clearCfProfiles();
  if (result.error) {
    res.status(409).json({ ok: false, removed: result.removed, message: result.error });
    return;
  }
  res.json({ ok: true, removed: result.removed });
});

// POST /cf-solver/uninstall -- delete every downloaded browser build, reclaiming the
// ~200MB each takes in the data dir. Refused while a job still has one open, since the
// binary would be pulled out from under it.
router.post("/cf-solver/uninstall", async (_req, res) => {
  if (cfInstalling) {
    res.status(409).json({ ok: false, message: "Install already in progress" });
    return;
  }
  const result = removeAllCfBuilds();
  if (result.error) {
    res.status(409).json({ ok: false, removed: result.removed, message: result.error });
    return;
  }
  // The solver has nothing to launch now, so it stops claiming to be on
  await setSetting("cf_solver_enabled", "false");
  res.json({ ok: true, removed: result.removed });
});

// Launching a browser, loading a real page over the network and probing it takes tens of
// seconds, and doing that for every installed build takes a multiple of it -- long enough
// that a reverse proxy in front of the panel gives up on the request and answers 504. So
// the run happens in the background and the caller polls for it, the way the bulk account
// operations already work.
type CfTestState = {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  ok?: boolean;
  error?: string;
  /** Filled in as each build finishes, so progress is visible rather than all-or-nothing. */
  builds: Array<Awaited<ReturnType<typeof testBrowser>>>;
};
let cfTestState: CfTestState | undefined;

router.post("/cf-solver/test", (req, res) => {
  if (cfTestState?.running) {
    res.status(409).json({ ...cfTestState, message: "A browser test is already running" });
    return;
  }

  // Every build that is installed, in turn. With both on disk a job may run on either --
  // the keyed one normally, the free one when no licence seat is going -- so testing only
  // the preferred build leaves the fallback unproven, which is exactly the one that gets
  // used on a bad day.
  const tiers = (["keyed", "free"] as const).filter((t) => !!chromiumExecutable(t));
  const wantShot = !!req.query.screenshot;

  if (!tiers.length) {
    cfTestState = {
      running: false,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      ok: false,
      error: "Chromium is not installed",
      builds: [],
    };
    res.json(cfTestState);
    return;
  }

  const state: CfTestState = { running: true, startedAt: Date.now(), builds: [] };
  cfTestState = state;

  void (async () => {
    try {
      for (const tier of tiers) {
        const result = await testBrowser(undefined, tier).catch((err: any) => ({
          ok: false,
          tier,
          error: err?.message ?? String(err),
        }));
        state.builds.push(wantShot ? result : { ...result, screenshot: undefined });
      }
      state.ok = state.builds.every((b) => b.ok);
    } catch (err: any) {
      state.ok = false;
      state.error = err?.message ?? String(err);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  res.status(202).json(state);
});

// GET /cf-solver/test -- how the run started above is going, and its results once it is
// done. Returns a finished-with-nothing state when no test has been run since boot.
router.get("/cf-solver/test", (_req, res) => {
  res.json(cfTestState ?? { running: false, startedAt: 0, builds: [] });
});

// ── Notification bot ──────────────────────────────────────────────────────────
// Job notifications are sent by a Telegram bot, so they no longer depend on a job having
// an authenticated account. A bot cannot start a conversation, and cannot resolve a user
// by @username, so the target has to be a numeric chat id the operator obtains by messaging
// the bot first -- which is what the two endpoints below are for.

/** The token to work with: the one supplied in the request, else the one stored. */
async function resolveBotToken(body: unknown): Promise<string | null> {
  const supplied = (body as { token?: string } | undefined)?.token?.trim();
  if (supplied && !supplied.includes("****")) return supplied;
  return (await getNotifyConfig()).botToken;
}

// GET /notify/bot -- who the stored token belongs to, so a mistyped or revoked token shows
// up here rather than as notifications that quietly never arrive.
router.get("/notify/bot", async (_req, res) => {
  const token = (await getNotifyConfig()).botToken;
  if (!token) {
    res.json({ configured: false });
    return;
  }
  const info = await getBotInfo(token);
  if (!info.ok) {
    res.json({ configured: true, ok: false, error: info.error });
    return;
  }
  res.json({
    configured: true,
    ok: true,
    id: info.result.id,
    username: info.result.username ?? "",
    name: info.result.first_name ?? "",
  });
});

// GET /notify/bot/chats -- chat ids the bot has heard from lately, for filling in the
// default target. Telegram only keeps recent updates, so an empty list usually means
// "message the bot and try again".
router.get("/notify/bot/chats", async (req, res) => {
  const token = await resolveBotToken(req.query);
  if (!token) {
    res.status(400).json({ ok: false, error: "No bot token configured" });
    return;
  }
  const chats = await recentBotChats(token);
  if (!chats.ok) {
    res.status(502).json({ ok: false, error: chats.error });
    return;
  }
  res.json({ ok: true, chats: chats.result });
});

// POST /notify/bot/test -- send a real message now. The only check that proves the whole
// path: token valid, host can reach the Bot API, and the target has started the bot.
router.post("/notify/bot/test", async (req, res) => {
  const token = await resolveBotToken(req.body);
  const cfg = await getNotifyConfig();
  const target = (req.body?.target as string | undefined)?.trim() || cfg.botTarget;
  if (!token) {
    res.status(400).json({ ok: false, error: "No bot token configured" });
    return;
  }
  if (!target) {
    res.status(400).json({ ok: false, error: "No notification target configured" });
    return;
  }
  try {
    await sendBotNotify(token, target, "🔔 Bemby test notification");
    res.json({ ok: true });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message ?? "Send failed" });
  }
});

// ── Proxy providers ───────────────────────────────────────────────────────────
// Configured proxy sellers whose current list can be pulled into the proxies setting.
// API keys are never sent back to the client; a `hasKey` flag stands in for them.

router.get("/proxy-providers", (_req, res) => {
  res.json({ providers: providersForClient() });
});

router.put("/proxy-providers", (req, res) => {
  const { providers } = req.body as { providers?: ProxyProvider[] };
  if (!Array.isArray(providers)) {
    res.status(400).json({ error: "providers array is required" });
    return;
  }

  const seen = new Set<string>();
  for (const p of providers) {
    if (!p?.id?.trim() || !p?.name?.trim()) {
      res.status(400).json({ error: "Each provider needs an id and a name" });
      return;
    }
    if (p.type !== "webshare" && p.type !== "list") {
      res.status(400).json({ error: `Unsupported provider type "${p.type}"` });
      return;
    }
    if (p.type === "list" && !p.url?.trim()) {
      res.status(400).json({ error: `"${p.name}" needs a list URL` });
      return;
    }
    if (seen.has(p.id)) {
      res.status(400).json({ error: "Provider ids must be unique" });
      return;
    }
    seen.add(p.id);
  }

  saveProviders(providers);
  res.json({ providers: providersForClient() });
});

// Pull the current lists in. `providerId` syncs a single provider; otherwise every
// enabled one is synced. Manual proxies, and imports from providers that were not
// synced, are preserved.
router.post("/proxy-providers/sync", async (req, res) => {
  const { providerId } = req.body as { providerId?: string };
  try {
    const result = await syncProviders(providerId?.trim() || undefined);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message ?? "Sync failed" });
  }
});

// Test TCP reachability through a SOCKS proxy (target: 1.1.1.1:80)
router.post("/test-proxy", async (req, res) => {
  const { url } = req.body as { url?: string };
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  const proxy = parseTgProxy(url);
  if (!proxy) {
    res
      .status(400)
      .json({ error: "Invalid proxy URL — use socks5:// or socks4://" });
    return;
  }

  try {
    const result = await SocksClient.createConnection({
      proxy: {
        host: proxy.ip,
        port: proxy.port,
        type: proxy.socksType,
        ...(proxy.username
          ? { userId: proxy.username, password: proxy.password }
          : {}),
      },
      command: "connect",
      destination: { host: "1.1.1.1", port: 80 },
      timeout: 6000,
    });
    result.socket.destroy();
    res.json({ ok: true });
  } catch (err: any) {
    res.json({ ok: false, error: err.message ?? "Connection failed" });
  }
});

export default router;
