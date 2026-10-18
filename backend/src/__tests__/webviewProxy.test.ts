// The viewer proxy serves a third-party page from Bemby's own origin, so what it will and
// will not do for that page is a security boundary rather than a detail. These drive a real
// upstream server through the real router.
//
// assertPublicUrl is stubbed because the upstream here is on loopback, which it exists to
// refuse; its own rules are covered by safeFetch.test.ts.
vi.mock("../tg/safeFetch", async () => {
  const actual = await vi.importActual<typeof import("../tg/safeFetch")>("../tg/safeFetch");
  return {
    ...actual,
    assertPublicUrl: async () => {},
    ssrfSafeFetch: (url: string, init: RequestInit) => fetch(url, init),
  };
});

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "http";
import { AddressInfo } from "net";
import webviewProxyRouter from "../routes/webviewProxy";
import { issueWebviewTicket, webviewProxyUrl } from "../tg/webviewTickets";

let upstream: http.Server;
let upstreamUrl = "";
let proxy: http.Server;
let proxyUrl = "";
let lastUpstreamRequest: { method: string; headers: http.IncomingHttpHeaders; body: string } = {
  method: "",
  headers: {},
  body: "",
};

const PAGE_HTML = `<!doctype html><html><head><base href="https://elsewhere.example/">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<script type="module" src="/assets/app.js" crossorigin></script>
<link rel="stylesheet" href="/assets/app.css">
</head><body><img src="/logo.png"><a href="/next">next</a></body></html>`;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastUpstreamRequest = {
        method: req.method ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      if (req.url?.startsWith("/api/")) {
        // The status an app's API replies with has to survive the trip
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html",
        // The very headers that make a page unframeable
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy": "frame-ancestors 'self' https://web.telegram.org",
      });
      res.end(PAGE_HTML);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const app = express();
  app.use("/api/webview", express.raw({ type: "*/*", limit: "10mb" }), webviewProxyRouter);
  proxy = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => proxy.once("listening", () => r()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => proxy.close(() => r()));
});

function proxied(ticketId: string, target: string): string {
  return `${proxyUrl}${webviewProxyUrl(ticketId, target)}`;
}

/** The path the page's own resources are rewritten to. */
function viaTicket(ticketId: string, target: string): string {
  return webviewProxyUrl(ticketId, target);
}

describe("the ticket is the whole credential", () => {
  it("refuses a request with no ticket, and one with a made-up ticket", async () => {
    const bare = await fetch(`${proxyUrl}/api/webview/r/`);
    expect(bare.status).toBe(400);
    const forged = await fetch(proxied("not-a-real-ticket", upstreamUrl));
    expect(forged.status).toBe(401);
  });

  it("refuses an address outside the site the ticket was issued for", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    const other = await fetch(proxied(ticket.id, "https://example.com/"));
    expect(other.status).toBe(403);
  });

  it("stops serving once the ticket has expired", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    ticket.expiresAt = Date.now() - 1;
    const after = await fetch(proxied(ticket.id, upstreamUrl));
    expect(after.status).toBe(401);
  });
});

describe("what reaches the page", () => {
  it("drops the framing headers and allows only Bemby to frame the copy", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    const resp = await fetch(proxied(ticket.id, `${upstreamUrl}/app`));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(resp.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    // The page's own opaque origin needs this to read its own requests back
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rewrites scripts and styles through the proxy and strips base and meta CSP", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    const html = await fetch(proxied(ticket.id, `${upstreamUrl}/app`)).then((r) => r.text());
    expect(html).not.toMatch(/<base\b/i);
    expect(html).not.toMatch(/http-equiv/i);
    expect(html).toContain(viaTicket(ticket.id, `${upstreamUrl}/assets/app.js`));
    expect(html).toContain(viaTicket(ticket.id, `${upstreamUrl}/assets/app.css`));
    // A module fetched same-origin must not still claim to be cross-origin
    expect(html).not.toMatch(/crossorigin/i);
    expect(html).toContain(viaTicket(ticket.id, `${upstreamUrl}/logo.png`));
  });

  it("injects the runtime shim ahead of the page's own scripts", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    const html = await fetch(proxied(ticket.id, `${upstreamUrl}/app`)).then((r) => r.text());
    expect(html).toContain("TelegramWebviewProxy");
    expect(html).toContain("sessionStorage");
    expect(html.indexOf("window.fetch =")).toBeLessThan(
      html.indexOf(viaTicket(ticket.id, `${upstreamUrl}/assets/app.js`)),
    );
    // The shim is assembled as a template, where a slip is a syntax error the browser would
    // report and nothing else would. new Function parses without running it.
    const body = /<script>\(function \(\) \{([\s\S]*?)\}\)\(\);<\/script>/.exec(html);
    expect(body).toBeTruthy();
    expect(() => new Function(body![1])).not.toThrow();
  });

  it("leaves the Telegram bridge out of a plain page, and routes its links", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/page`, "page");
    const html = await fetch(proxied(ticket.id, `${upstreamUrl}/page`)).then((r) => r.text());
    expect(html).not.toContain("TelegramWebviewProxy");
    expect(html).toContain(viaTicket(ticket.id, `${upstreamUrl}/next`));
  });
});

// The shim decides where every runtime request goes, and it only runs in a browser. Rather
// than trust it by reading, the served script is executed here against a stub of the handful
// of things it touches, and asked where it would send each kind of URL.
describe("the runtime shim", () => {
  async function runShim(ticketId: string, pageUrl: string) {
    const html = await fetch(proxied(ticketId, pageUrl)).then((r) => r.text());
    const body = /<script>\(function \(\) \{([\s\S]*?)\}\)\(\);<\/script>/.exec(html)?.[1];
    expect(body).toBeTruthy();

    const here = "http://bemby.local";
    const baseURI = `${here}${webviewProxyUrl(ticketId, pageUrl)}`;
    const routed: string[] = [];

    class FakeLink {
      _href = "";
      set href(v: string) {
        this._href = v;
      }
      get href(): string {
        return this._href;
      }
    }
    class FakeElement {
      attrs: Record<string, string> = {};
      setAttribute(name: string, value: string) {
        this.attrs[name] = value;
      }
    }

    const win: any = {
      location: { origin: here },
      HTMLLinkElement: FakeLink,
      fetch: (u: string) => {
        routed.push(String(u));
        return Promise.resolve();
      },
    };
    const doc = { baseURI };
    const xhr: any = { prototype: { open: (_m: string, u: string) => routed.push(String(u)) } };

    new Function(
      "window",
      "document",
      "location",
      "navigator",
      "XMLHttpRequest",
      "Element",
      "HTMLLinkElement",
      "HTMLScriptElement",
      "HTMLImageElement",
      body!,
    )(win, doc, win.location, {}, xhr, FakeElement, FakeLink, undefined, undefined);

    return { win, xhr, routed, FakeLink, FakeElement };
  }

  it("sends a chunk preloaded at runtime to the site, not to Bemby's root", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    const { FakeLink } = await runShim(ticket.id, `${upstreamUrl}/app`);
    // What a bundle's preload helper does: build a <link> and give it an absolute path
    const link: any = new FakeLink();
    link.href = "/assets/chunk-abc.js";
    expect(link._href).toBe(webviewProxyUrl(ticket.id, `${upstreamUrl}/assets/chunk-abc.js`));
  });

  it("routes an attribute the same way, and leaves an already-proxied one alone", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    const { FakeElement } = await runShim(ticket.id, `${upstreamUrl}/app`);
    const el: any = new FakeElement();
    el.setAttribute("src", "/assets/img.png");
    expect(el.attrs.src).toBe(webviewProxyUrl(ticket.id, `${upstreamUrl}/assets/img.png`));

    const already = webviewProxyUrl(ticket.id, `${upstreamUrl}/assets/img.png`);
    el.setAttribute("src", already);
    expect(el.attrs.src).toBe(already);
  });

  it("routes the app's own API calls and lets a third party's go direct", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    const { win, xhr, routed } = await runShim(ticket.id, `${upstreamUrl}/app`);

    await win.fetch("/api/v1/users/me");
    expect(routed.pop()).toBe(webviewProxyUrl(ticket.id, `${upstreamUrl}/api/v1/users/me`));

    xhr.prototype.open("GET", `${upstreamUrl}/api/v1/orders`);
    expect(routed.pop()).toBe(webviewProxyUrl(ticket.id, `${upstreamUrl}/api/v1/orders`));

    // A ticket does not cover another party, so proxying it would only earn a 403
    await win.fetch("https://telegram.org/js/telegram-web-app.js");
    expect(routed.pop()).toBe("https://telegram.org/js/telegram-web-app.js");
  });

  it("stands in for storage, which throws outright in an opaque origin", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    const { win } = await runShim(ticket.id, `${upstreamUrl}/app`);
    win.localStorage.setItem("token", "abc");
    expect(win.localStorage.getItem("token")).toBe("abc");
    expect(win.localStorage.length).toBe(1);
    expect(win.sessionStorage.getItem("missing")).toBeNull();
  });
});

describe("what reaches the site", () => {
  it("forwards the method, the body and the content type of an app's API call", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    const resp = await fetch(proxied(ticket.id, `${upstreamUrl}/api/join`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joined: true }),
    });
    // The app has to see its own status, not a 200 wrapping a failure
    expect(resp.status).toBe(401);
    expect(lastUpstreamRequest.method).toBe("POST");
    expect(lastUpstreamRequest.body).toBe(JSON.stringify({ joined: true }));
    expect(lastUpstreamRequest.headers["content-type"]).toBe("application/json");
  });

  it("never forwards Bemby's cookies", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    await fetch(proxied(ticket.id, `${upstreamUrl}/app`), {
      headers: { cookie: "bemby_session=secret" },
    });
    expect(lastUpstreamRequest.headers.cookie).toBeUndefined();
  });

  it("answers a preflight itself, so an opaque origin is not turned away", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/app`, "app");
    const resp = await fetch(`${proxyUrl}/api/webview/r/${ticket.id}/https/example.com/`, {
      method: "OPTIONS",
      headers: { "access-control-request-headers": "content-type" },
    });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    expect(resp.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  it("tells a preflight holding no ticket nothing at all", async () => {
    // This router is mounted outside the session guard, so an arbitrary site must not be
    // able to talk it into echoing its own origin back with Allow-Credentials.
    const resp = await fetch(`${proxyUrl}/api/webview/r/not-a-ticket/https/example.com/`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-headers": "content-type" },
    });
    expect(resp.status).toBe(401);
    expect(resp.headers.get("access-control-allow-origin")).toBeNull();
    expect(resp.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
