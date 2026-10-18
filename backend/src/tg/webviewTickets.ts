import { randomBytes } from "crypto";

// A page shown in the messenger viewer is served from Bemby's own origin by the proxy, so
// whatever credential that page's address carries is readable by the site's own scripts
// (location.search is not hidden from them). A Bemby session token there would hand a
// third-party page the whole API. A ticket is issued instead: it authorises one thing --
// fetching from the site it was issued for, for a while -- so a page that reads its own
// ticket gains nothing it could not already do by talking to its own server.

export type WebviewMode = "app" | "page";

export type WebviewTicket = {
  id: string;
  /** The address the ticket was issued for, which is what the proxy will serve. */
  origin: string;
  host: string;
  /** `app` also injects the Mini App runtime shim; `page` is a plain web page. */
  mode: WebviewMode;
  expiresAt: number;
};

/** Long enough for a session in the viewer, short enough that a leaked ticket goes stale. */
const TTL_MS = 30 * 60_000;

/** Cap so a long session cannot grow the map without bound; oldest go first. */
const MAX_TICKETS = 200;

const tickets = new Map<string, WebviewTicket>();

function sweep(): void {
  const now = Date.now();
  for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id);
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next();
    if (oldest.done) break;
    tickets.delete(oldest.value);
  }
}

/** Issues a ticket for one address. Throws when the URL is not one that can be proxied. */
export function issueWebviewTicket(url: string, mode: WebviewMode): WebviewTicket {
  const parsed = new URL(url);
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error("Only http(s) allowed");
  sweep();
  const ticket: WebviewTicket = {
    id: randomBytes(24).toString("base64url"),
    origin: parsed.origin,
    host: parsed.hostname.toLowerCase(),
    mode,
    expiresAt: Date.now() + TTL_MS,
  };
  tickets.set(ticket.id, ticket);
  return ticket;
}

export function resolveWebviewTicket(id: string | undefined): WebviewTicket | undefined {
  if (!id) return undefined;
  const ticket = tickets.get(id);
  if (!ticket) return undefined;
  if (ticket.expiresAt <= Date.now()) {
    tickets.delete(id);
    return undefined;
  }
  return ticket;
}

/**
 * A second address for this same server, e.g. `http://ports2.example.com:53333` -- another
 * hostname pointing at the same host and port is enough, no extra port or certificate.
 *
 * Why it is needed: a Mini App reads `location.pathname` to route itself, so it has to own `/`
 * on whatever origin serves it, and Bemby's own panel already owns `/` on its origin. Served
 * under a path prefix instead, the app's router matches nothing and it renders an empty page.
 * `window.location` cannot be shimmed, so a separate origin is the only way.
 *
 * Keeping it on the same registrable domain matters twice over: the ticket cookie is then
 * same-site, so it needs no `Secure` and works over plain http; and the origin is still
 * distinct, so the page cannot reach the panel's storage where the session token lives.
 */
export function webviewPublicOrigin(): string | undefined {
  const raw = process.env.WEBVIEW_PUBLIC_ORIGIN?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/i.test(parsed.protocol)) throw new Error("scheme");
    return parsed.origin;
  } catch {
    console.warn(`[webview] ignoring WEBVIEW_PUBLIC_ORIGIN: "${raw}" is not a valid origin`);
    return undefined;
  }
}

/** Whether a request's Host names the viewer origin, so it is the app that should answer. */
export function isWebviewHost(host: string | undefined, publicOrigin: string): boolean {
  if (!host) return false;
  const want = new URL(publicOrigin);
  const [name] = host.toLowerCase().split(":");
  return name === want.hostname.toLowerCase();
}

/** The cookie the claim step leaves behind; HttpOnly, so the page cannot read its own ticket. */
export const WEBVIEW_COOKIE = "bemby_webview";

/** Path that trades the ticket in the address for the cookie, then steps out of the way. */
export const WEBVIEW_CLAIM_PATH = "/__bemby_webview_claim";

/**
 * The address the viewer loads: the claim path on the viewer origin, carrying the ticket once
 * and the app's own path to land on. The fragment rides along untouched -- a browser keeps it
 * across a redirect, and never sends it to a server, which is where a Mini App's signed
 * account data lives.
 */
export function webviewClaimUrl(ticketId: string, url: string, publicOrigin: string): string {
  const target = new URL(url);
  const fragment = target.hash;
  const landing = `${target.pathname}${target.search}`;
  return (
    `${publicOrigin}${WEBVIEW_CLAIM_PATH}?t=${encodeURIComponent(ticketId)}` +
    `&to=${encodeURIComponent(landing)}${fragment}`
  );
}

/**
 * Where the proxy serves a ticket's pages when no viewer origin is configured. Shaped as a
 * path so the page's own relative URLs and module imports resolve through it, which a query
 * string cannot stand in for. A Mini App needs the origin above; this still suits a plain page.
 */
export function webviewProxyPath(ticketId: string): string {
  return `/api/webview/r/${encodeURIComponent(ticketId)}`;
}

/** Turns an address into the one the viewer loads, keeping the fragment on the browser side. */
export function webviewProxyUrl(ticketId: string, url: string): string {
  const target = new URL(url);
  const fragment = target.hash; // never sent to a server; a Mini App reads its account from it
  target.hash = "";
  return (
    `${webviewProxyPath(ticketId)}/${target.protocol.replace(":", "")}/${target.host}` +
    `${target.pathname}${target.search}${fragment}`
  );
}

/**
 * Second-level labels that are part of a public suffix rather than something anyone can
 * register, when they sit under a two-letter country code: `com.au`, `co.uk`, `ac.nz` and
 * their like. Without this the last two labels of `shop.com.au` read as `com.au`, and a
 * ticket for one Australian site would authorise the proxy to fetch any of them.
 *
 * A heuristic rather than the full public suffix list, which is thousands of entries and a
 * dependency this does not otherwise need. It errs towards the tighter answer: an unlisted
 * suffix means the ticket covers less than it could, never more.
 */
const COUNTRY_SECOND_LEVEL = new Set([
  "ac", "art", "asn", "biz", "co", "com", "edu", "firm", "gen", "go", "gob", "gouv", "gov",
  "govt", "id", "in", "info", "ltd", "me", "mil", "ne", "net", "nom", "or", "org", "plc",
  "sch", "school", "web",
]);

/**
 * The registrable domain: the part of a host someone actually owns, which is what a
 * same-party comparison has to be made against. Shared with the two viewer routers so all
 * three agree on where one site ends and another begins.
 */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const [sld, tld] = labels.slice(-2);
  const take = tld.length === 2 && COUNTRY_SECOND_LEVEL.has(sld) ? 3 : 2;
  // A host that is nothing but a public suffix has no registrable domain; returning it whole
  // keeps the comparison below to an exact match rather than opening the suffix up.
  if (labels.length < take) return labels.join(".");
  return labels.slice(-take).join(".");
}

/** Whether a host belongs to the given registrable domain, itself included. */
export function sameParty(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

/**
 * Whether a ticket may fetch an address: its own origin, or another host on the same
 * registrable domain. Apps commonly serve their page and their API from sibling hosts, so
 * pinning to the exact origin would break them, while allowing anything at all would make
 * the proxy a relay for any page holding a ticket.
 */
export function ticketAllowsUrl(ticket: WebviewTicket, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(parsed.protocol)) return false;
  if (parsed.origin === ticket.origin) return true;
  return sameParty(parsed.hostname, registrableDomain(ticket.host));
}
