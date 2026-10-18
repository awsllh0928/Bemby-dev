import { getSetting, setSetting } from "../db/repos/settings";
import { cfTuning } from "../jobs/cfTuning";

// Proxy sellers hand out lists that change over time -- addresses get replaced, plans
// get resized. Rather than pasting each proxy into Settings by hand, a provider can be
// configured once and its current list pulled in on demand. This matters most for
// Cloudflare solving, where only some exit IPs are accepted, so a larger and current
// pool is what makes a working one findable.
//
// Two adapters cover the field without a provider-specific plugin for each vendor:
//   - `webshare`: the webshare.io API (token auth, paginated JSON)
//   - `list`: any URL returning a plain-text list, the format nearly every seller's
//     "download list" link produces (ip:port:user:pass and friends)

const TIMEOUT_MS = 20_000;
const WEBSHARE_API_URL = "https://proxy.webshare.io/api/v2/proxy/list/";
const WEBSHARE_PAGE_SIZE = 100;
const PAGE_LIMIT = 20; // backstop against a paginating loop
const MAX_LIST_BYTES = 2_000_000;

/** Prefix marking an imported proxy, so manually added entries are never touched. */
export const IMPORTED_ID_PREFIX = "pp:";

/**
 * Prefix used before proxies were grouped by provider. Syncing Webshare adopts these so
 * the entries are replaced rather than left behind as duplicates of themselves.
 */
const LEGACY_WEBSHARE_PREFIX = "ws:";

export type ProxyProviderType = "webshare" | "list";

export type ProxyProvider = {
  id: string;
  name: string;
  type: ProxyProviderType;
  /** Token for the provider's API, or a bearer token for a protected list URL. */
  apiKey?: string;
  /** Where to fetch a plain-text list from (`list` type only). */
  url?: string;
  /** Scheme to assume for list entries that don't state one. */
  scheme?: "http" | "socks5";
  enabled?: boolean;
};

/** A proxy entry as stored in the `proxies` setting. */
export type BembyProxy = { id: string; name: string; url: string; host?: string };

export type ProviderSyncResult = {
  providerId: string;
  name: string;
  ok: boolean;
  fetched?: number;
  error?: string;
};

export type SyncResult = {
  providers: ProviderSyncResult[];
  added: number;
  updated: number;
  removed: number;
  total: number;
};

// ── Stored configuration ──────────────────────────────────────────────────────

async function readSetting(key: string): Promise<string | undefined> {
  return await getSetting(key);
}

async function writeSetting(key: string, value: string): Promise<void> {
  await setSetting(key, value);
}

/**
 * Reads the configured providers, folding in the standalone Webshare token that earlier
 * versions stored on its own so an upgraded install keeps working.
 */
export async function readProviders(): Promise<ProxyProvider[]> {
  let providers: ProxyProvider[] = [];
  try {
    const parsed = JSON.parse((await readSetting("proxy_providers")) ?? "[]");
    if (Array.isArray(parsed)) providers = parsed as ProxyProvider[];
  } catch {
    providers = [];
  }

  const legacyKey = await readSetting("webshare_api_key");
  if (legacyKey && !providers.some((p) => p.type === "webshare")) {
    providers = [
      ...providers,
      { id: "webshare", name: "Webshare", type: "webshare", apiKey: legacyKey, enabled: true },
    ];
    await writeProviders(providers);
  }

  return providers;
}

export async function writeProviders(providers: ProxyProvider[]): Promise<void> {
  await writeSetting("proxy_providers", JSON.stringify(providers));
}

/** Providers with secrets replaced by a flag, for sending to the client. */
export async function providersForClient(): Promise<
  Array<Omit<ProxyProvider, "apiKey"> & { hasKey: boolean }>
> {
  return (await readProviders()).map(({ apiKey, ...rest }) => ({
    ...rest,
    hasKey: !!apiKey,
  }));
}

/**
 * Saves an incoming provider list, carrying over any key the client left blank -- it
 * never receives the stored keys, so a blank one means "unchanged", not "cleared".
 */
export async function saveProviders(
  incoming: ProxyProvider[],
): Promise<ProxyProvider[]> {
  const existing = new Map((await readProviders()).map((p) => [p.id, p]));
  const merged = incoming.map((p) => ({
    ...p,
    apiKey: p.apiKey?.trim() ? p.apiKey.trim() : existing.get(p.id)?.apiKey,
  }));
  await writeProviders(merged);
  return merged;
}

// ── Adapters ──────────────────────────────────────────────────────────────────

type WebshareProxy = {
  id: string;
  username: string;
  password: string;
  proxy_address: string;
  port: number;
  valid?: boolean;
  country_code?: string;
  city_name?: string;
};

async function fetchWebshare(provider: ProxyProvider): Promise<BembyProxy[]> {
  const apiKey = provider.apiKey?.trim();
  if (!apiKey) throw new Error("API token is not set");

  const out: BembyProxy[] = [];
  let url: string | null = `${WEBSHARE_API_URL}?mode=direct&page_size=${WEBSHARE_PAGE_SIZE}`;

  for (let page = 0; url && page < PAGE_LIMIT; page++) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Token ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        res.status === 401
          ? "Webshare rejected the API token"
          : `Webshare API error ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as { next: string | null; results: WebshareProxy[] };
    for (const p of data.results ?? []) {
      // Skip addresses Webshare itself reports as not working
      if (p.valid === false) continue;
      const where = [p.country_code, p.city_name].filter(Boolean).join(" ");
      out.push({
        id: proxyId(provider, p.id),
        name: `${provider.name} ${where || p.proxy_address}`.trim(),
        url: `http://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.proxy_address}:${p.port}`,
        host: "",
      });
    }
    url = data.next;
  }

  return out;
}

/**
 * Parses one line of a downloaded proxy list. Handles the shapes sellers use:
 * `ip:port`, `ip:port:user:pass`, `user:pass@ip:port` and any of those with a
 * `scheme://` in front. Returns undefined for blanks, comments and malformed lines.
 */
export function parseProxyLine(line: string, fallbackScheme = "http"): string | undefined {
  const raw = line.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//")) return undefined;

  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const scheme = (schemeMatch?.[1] ?? fallbackScheme).toLowerCase();
  const body = schemeMatch ? raw.slice(schemeMatch[0].length) : raw;

  const hostPort = (value: string): { host: string; port: string } | undefined => {
    const m = value.match(/^\[?([^\]\s]+?)\]?:(\d{1,5})$/);
    return m ? { host: m[1], port: m[2] } : undefined;
  };

  // user:pass@host:port
  const atIndex = body.lastIndexOf("@");
  if (atIndex > 0) {
    const creds = body.slice(0, atIndex).split(":");
    const target = hostPort(body.slice(atIndex + 1));
    if (!target || creds.length !== 2 || !creds[0]) return undefined;
    return `${scheme}://${encodeURIComponent(creds[0])}:${encodeURIComponent(creds[1])}@${target.host}:${target.port}`;
  }

  const parts = body.split(":");
  if (parts.length === 2) {
    const target = hostPort(body);
    return target ? `${scheme}://${target.host}:${target.port}` : undefined;
  }
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    if (!/^\d{1,5}$/.test(port) || !host || !user) return undefined;
    return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return undefined;
}

async function fetchList(provider: ProxyProvider): Promise<BembyProxy[]> {
  const url = provider.url?.trim();
  if (!url) throw new Error("List URL is not set");

  const res = await fetch(url, {
    headers: provider.apiKey?.trim() ? { Authorization: `Bearer ${provider.apiKey.trim()}` } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`List URL returned ${res.status}`);

  const body = (await res.text()).slice(0, MAX_LIST_BYTES);
  const out: BembyProxy[] = [];
  const seen = new Set<string>();

  for (const line of body.split(/\r?\n/)) {
    const proxyUrl = parseProxyLine(line, provider.scheme ?? "http");
    if (!proxyUrl || seen.has(proxyUrl)) continue;
    seen.add(proxyUrl);
    // Address and port identify the entry, so ids stay stable as the list is re-fetched
    const { hostname, port } = new URL(proxyUrl);
    out.push({
      id: proxyId(provider, `${hostname}:${port}`),
      name: `${provider.name} ${hostname}`,
      url: proxyUrl,
      host: "",
    });
  }

  if (!out.length) throw new Error("No proxies found at that URL");
  return out;
}

function proxyId(provider: ProxyProvider, remoteId: string): string {
  return `${IMPORTED_ID_PREFIX}${provider.id}:${remoteId}`;
}

/** Fetches one provider's current list without touching stored settings. */
export function fetchFromProvider(provider: ProxyProvider): Promise<BembyProxy[]> {
  switch (provider.type) {
    case "webshare":
      return fetchWebshare(provider);
    case "list":
      return fetchList(provider);
    default:
      return Promise.reject(new Error(`Unknown provider type "${provider.type}"`));
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

// ── Cloudflare solving: proxy candidates ──────────────────────────────────────

/** One browser-proxy option for a Cloudflare attempt. `url` undefined means direct. */
export type ProxyCandidate = { id: string; label: string; url?: string };

const CF_WINS_KEY = "cf_proxy_last_ok";
// Cloudflare accepts a minority of exits, so a first run needs room to find one. A
// refused attempt is cut short as soon as the page says so, keeping this affordable.
// Both counts are configurable in Settings (cfTuning).
const candidateCount = async () => (await cfTuning()).proxyCandidates;
/** Sanity ceiling for callers that offer the whole pool, however large it has grown. */
export const cfMaxCandidates = async () => (await cfTuning()).maxPoolCandidates;

async function readCfWins(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse((await readSetting(CF_WINS_KEY)) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const CF_GEO_KEY = "cf_exit_geo";

/** Where an exit comes out, so the browser can present a matching locale and clock. */
export type CfExitGeo = { loc: string; tz?: string; lang?: string };

async function readCfGeo(): Promise<Record<string, CfExitGeo>> {
  try {
    const parsed = JSON.parse((await readSetting(CF_GEO_KEY)) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, CfExitGeo>) : {};
  } catch {
    return {};
  }
}

/** The known geography of an exit, looked up by its stable key. */
export async function cfExitGeo(
  exitKey: string,
): Promise<CfExitGeo | undefined> {
  return (await readCfGeo())[exitKey];
}

/**
 * Remembers where an exit comes out. Looked up once per exit and kept, since the
 * lookup costs a page load and a proxy's country does not move.
 */
export async function rememberCfExitGeo(
  exitKey: string,
  geo: CfExitGeo,
): Promise<void> {
  if (!exitKey || !geo.loc) return;
  const all = await readCfGeo();
  const known = all[exitKey];
  if (known?.loc === geo.loc && known?.tz === geo.tz && known?.lang === geo.lang) return;
  all[exitKey] = geo;
  await writeSetting(CF_GEO_KEY, JSON.stringify(all));
}

/** Records which proxy cleared a challenge on a host, so the next run starts there. */
export async function rememberCfProxy(
  host: string,
  proxyId: string,
): Promise<void> {
  if (!host) return;
  const wins = await readCfWins();
  if (wins[host] === proxyId) return;
  wins[host] = proxyId;
  await writeSetting(CF_WINS_KEY, JSON.stringify(wins));
}

/** Value of a pinned proxy id meaning "no proxy for the browser". */
export const CF_PROXY_DIRECT = "direct";

/**
 * Ordered proxies for a Cloudflare attempt, with the caller's own preference honoured:
 * `proxyId` pins one exit from the pool (or `direct` for none) instead of the job's
 * proxy, and `tryAll: false` keeps the run to that single exit rather than working
 * through the pool. A pinned exit always stays first -- the host's last winner only
 * leads when nothing was pinned.
 *
 * `exclude` drops exits that have already had their turn, so a retry moves further into
 * the pool instead of cycling the same few -- which is also what lets a pool bigger than
 * one attempt's window (imported proxies sit after the manually added ones) be covered.
 */
export async function cfProxyCandidatesFor(opts: {
  primaryUrl?: string;
  host?: string;
  /** Pool id of a pinned proxy, or `direct`. */
  proxyId?: string;
  /** Fall through the rest of the pool when an exit is refused. Defaults to true. */
  tryAll?: boolean;
  max?: number;
  /** Ids of exits already tried; each proxy is offered once. */
  exclude?: Iterable<string>;
}): Promise<ProxyCandidate[]> {
  const { primaryUrl, host, proxyId, tryAll = true } = opts;
  const max = opts.max ?? (await candidateCount());
  const pool = await readProxies();
  const tried = new Set(opts.exclude ?? []);

  const pinned = proxyId && proxyId !== CF_PROXY_DIRECT ? pool.find((p) => p.id === proxyId) : undefined;
  const primary: ProxyCandidate = pinned
    ? { id: pinned.id, label: pinned.name, url: pinned.url }
    : proxyId === CF_PROXY_DIRECT
      ? { id: CF_PROXY_DIRECT, label: "direct", url: undefined }
      : {
          id: pool.find((p) => p.url === primaryUrl)?.id ?? (primaryUrl ? "job" : "direct"),
          label: pool.find((p) => p.url === primaryUrl)?.name ?? (primaryUrl ? "job proxy" : "direct"),
          url: primaryUrl,
        };

  if (!tryAll) return tried.has(primary.id) ? [] : [primary];

  const rest: ProxyCandidate[] = pool
    .filter((p) => p.url && p.url !== primary.url && !tried.has(p.id))
    .map((p) => ({ id: p.id, label: p.name, url: p.url }));

  // Lead with the proxy that cleared this host last time, wherever it sits in the pool
  const winnerId = host && !proxyId ? (await readCfWins())[host] : undefined;
  const winnerIndex = winnerId ? rest.findIndex((c) => c.id === winnerId) : -1;
  const head = tried.has(primary.id) ? [] : [primary];
  const ordered =
    winnerIndex >= 0
      ? [rest[winnerIndex], ...head, ...rest.filter((_, i) => i !== winnerIndex)]
      : [...head, ...rest];

  const seen = new Set<string>();
  return ordered
    .filter((c) => {
      const key = c.url ?? "direct";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, Math.min(max, await cfMaxCandidates())));
}

async function readProxies(): Promise<BembyProxy[]> {
  try {
    const parsed = JSON.parse((await readSetting("proxies")) ?? "[]");
    return Array.isArray(parsed) ? (parsed as BembyProxy[]) : [];
  } catch {
    return [];
  }
}

const importedByProvider = (id: string) => `${IMPORTED_ID_PREFIX}${id}:`;

/**
 * Pulls the current list from each enabled provider (or just `onlyProviderId`) and
 * rewrites that provider's share of the proxy list. Manually added proxies, and imports
 * belonging to providers that were not synced, are left as they are. Ids are derived
 * from the provider's own identifiers so anything pinned to a proxy survives a sync.
 *
 * A provider that fails leaves its previously imported proxies in place -- a transient
 * API outage should not strip the pool a job is about to use.
 */
export async function syncProviders(onlyProviderId?: string): Promise<SyncResult> {
  const providers = (await readProviders()).filter(
    (p) => (onlyProviderId ? p.id === onlyProviderId : p.enabled !== false),
  );
  if (!providers.length) {
    throw new Error(onlyProviderId ? "Provider not found" : "No proxy providers configured");
  }

  const results: ProviderSyncResult[] = [];
  const fetched: BembyProxy[] = [];
  const syncedIds: string[] = [];

  for (const provider of providers) {
    try {
      const list = await fetchFromProvider(provider);
      fetched.push(...list);
      syncedIds.push(provider.id);
      results.push({ providerId: provider.id, name: provider.name, ok: true, fetched: list.length });
    } catch (err: any) {
      results.push({
        providerId: provider.id,
        name: provider.name,
        ok: false,
        error: err?.message ?? "Fetch failed",
      });
    }
  }

  const existing = await readProxies();
  const replacedPrefixes = syncedIds.map(importedByProvider);
  // Sweep up entries imported by the pre-provider build when Webshare is refreshed
  if (providers.some((p) => syncedIds.includes(p.id) && p.type === "webshare")) {
    replacedPrefixes.push(LEGACY_WEBSHARE_PREFIX);
  }
  const isReplaced = (p: BembyProxy) => replacedPrefixes.some((prefix) => p.id.startsWith(prefix));

  const kept = existing.filter((p) => !isReplaced(p));
  const previous = new Map(existing.filter(isReplaced).map((p) => [p.id, p]));

  let added = 0;
  let updated = 0;
  for (const p of fetched) {
    const prev = previous.get(p.id);
    if (!prev) added++;
    else if (prev.url !== p.url || prev.name !== p.name) updated++;
  }
  const fetchedIds = new Set(fetched.map((p) => p.id));
  const removed = [...previous.keys()].filter((id) => !fetchedIds.has(id)).length;

  const merged = [...kept, ...fetched];
  await writeSetting("proxies", JSON.stringify(merged));

  return { providers: results, added, updated, removed, total: merged.length };
}
