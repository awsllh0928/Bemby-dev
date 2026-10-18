// The viewer origin serves a framed page at its own root, which is the only arrangement a Mini
// App's router survives. These cover the claim handshake, what the cookie does and does not
// authorise, and the header rewriting in both directions.
//
// assertPublicUrl is stubbed because the upstream here is on loopback, which it exists to
// refuse; its own rules are covered by safeFetch.test.ts.
vi.mock("../tg/safeFetch", async () => {
  const actual = await vi.importActual<typeof import("../tg/safeFetch")>("../tg/safeFetch");
  return {
    ...actual,
    assertPublicUrl: async () => {},
    ssrfSafeFetch: (
      url: string,
      init: RequestInit,
      options?: { followRedirects?: boolean },
    ) =>
      fetch(url, {
        ...init,
        redirect: options?.followRedirects === false ? "manual" : "follow",
      }),
  };
});

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { chromium } from "playwright-core";
import express from "express";
import http from "http";
import { AddressInfo } from "net";
import webviewSiteRouter from "../routes/webviewSite";
import { chromiumExecutable } from "../jobs/cfBrowser";
import {
  issueWebviewTicket,
  WEBVIEW_CLAIM_PATH,
  WEBVIEW_COOKIE,
  webviewClaimUrl,
} from "../tg/webviewTickets";

let upstream: http.Server;
let upstreamUrl = "";
let viewer: http.Server;
let viewerUrl = "";
let lastRequest: { url: string; method: string; headers: http.IncomingHttpHeaders } = {
  url: "",
  method: "",
  headers: {},
};

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    lastRequest = { url: req.url ?? "", method: req.method ?? "", headers: req.headers };
    if (req.url?.startsWith("/api/")) {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "sid=abc; Domain=bot.example.com; Path=/; Secure; SameSite=None",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/go") {
      res.writeHead(302, { location: `${upstreamUrl}/landed` });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html",
      "x-frame-options": "SAMEORIGIN",
      "content-security-policy": "frame-ancestors 'self'",
    });
    res.end(
      `<!doctype html><html><head><base href="https://elsewhere.example/">` +
        `<script type="module" src="/assets/app.js"></script>` +
        `<script src="${upstreamUrl}/assets/two.js"></script>` +
        `<script src="https://telegram.org/js/telegram-web-app.js"></script>` +
        `</head><body>hello</body></html>`,
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const app = express();
  app.use(webviewSiteRouter);
  viewer = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => viewer.once("listening", () => r()));
  viewerUrl = `http://127.0.0.1:${(viewer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => viewer.close(() => r()));
});

/** Walks the claim handshake and returns the cookie a browser would then hold. */
async function claim(target: string): Promise<{ cookie: string; location: string }> {
  const ticket = issueWebviewTicket(target, "app");
  const claimUrl = webviewClaimUrl(ticket.id, target, viewerUrl);
  const resp = await fetch(claimUrl, { redirect: "manual" });
  expect(resp.status).toBe(302);
  const setCookie = resp.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(WEBVIEW_COOKIE);
  // HttpOnly is the point: the page must not be able to read its own ticket
  expect(setCookie).toContain("HttpOnly");
  return {
    cookie: setCookie.split(";")[0],
    location: resp.headers.get("location") ?? "",
  };
}

describe("the claim handshake", () => {
  it("puts the ticket in an HttpOnly cookie and sends the page to its own path", async () => {
    const { location } = await claim(`${upstreamUrl}/?tgWebAppStartParam=xyz`);
    // The app's own path, not the proxy's -- which is what lets its router match
    expect(location).toBe("/?tgWebAppStartParam=xyz");
  });

  it("keeps the fragment out of the address it is given", async () => {
    const ticket = issueWebviewTicket(`${upstreamUrl}/`, "app");
    const url = webviewClaimUrl(ticket.id, `${upstreamUrl}/?a=1#tgWebAppData=secret`, viewerUrl);
    // A fragment is never sent to a server; the browser carries it across the redirect
    expect(url).toContain("#tgWebAppData=secret");
    expect(url.split("#")[0]).not.toContain("secret");
  });

  it("refuses a made-up ticket", async () => {
    const resp = await fetch(`${viewerUrl}${WEBVIEW_CLAIM_PATH}?t=nope&to=/`, {
      redirect: "manual",
    });
    expect(resp.status).toBe(401);
  });

  it("serves nothing without the cookie", async () => {
    const resp = await fetch(`${viewerUrl}/`);
    expect(resp.status).toBe(401);
  });
});

describe("serving the page at the root", () => {
  it("maps the path straight onto the site", async () => {
    const { cookie } = await claim(`${upstreamUrl}/`);
    const resp = await fetch(`${viewerUrl}/some/deep/path?q=1`, { headers: { cookie } });
    expect(resp.status).toBe(200);
    expect(lastRequest.url).toBe("/some/deep/path?q=1");
  });

  it("drops the framing headers and lets only the panel's domain frame it", async () => {
    const { cookie } = await claim(`${upstreamUrl}/`);
    const resp = await fetch(`${viewerUrl}/`, { headers: { cookie } });
    // X-Frame-Options cannot express "a sibling host", and SAMEORIGIN would refuse the panel
    expect(resp.headers.get("x-frame-options")).toBeNull();
    expect(resp.headers.get("content-security-policy")).toContain("frame-ancestors");
    expect(resp.headers.get("content-security-policy")).not.toContain("'none'");
  });

  it("folds the site's absolute URLs onto this origin and leaves a third party's alone", async () => {
    const { cookie } = await claim(`${upstreamUrl}/`);
    const html = await fetch(`${viewerUrl}/`, { headers: { cookie } }).then((r) => r.text());
    expect(html).not.toMatch(/<base\b/i);
    // Its own absolute URL would leave this origin and be refused by CORS
    expect(html).toContain('src="/assets/two.js"');
    // A relative one already points here, so it is untouched
    expect(html).toContain('src="/assets/app.js"');
    // Telegram's SDK must stay where it is, or the ticket refuses it and the app has no WebApp
    expect(html).toContain('src="https://telegram.org/js/telegram-web-app.js"');
    expect(html).toContain("TelegramWebviewProxy");
  });

  it("keeps a redirect to the site inside the viewer", async () => {
    const { cookie } = await claim(`${upstreamUrl}/`);
    const resp = await fetch(`${viewerUrl}/go`, { headers: { cookie }, redirect: "manual" });
    expect(resp.headers.get("location")).toBe("/landed");
  });
});

describe("cookies", () => {
  it("re-scopes the site's cookie for this origin", async () => {
    const { cookie } = await claim(`${upstreamUrl}/`);
    const resp = await fetch(`${viewerUrl}/api/v1/me`, { headers: { cookie } });
    const setCookie = resp.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("sid=abc");
    // The site's Domain is not ours, and Secure/SameSite=None would be dropped over http
    expect(setCookie).not.toMatch(/domain=/i);
    expect(setCookie).not.toMatch(/samesite=none/i);
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("forwards the site's own cookies but never the viewer ticket", async () => {
    const { cookie } = await claim(`${upstreamUrl}/`);
    await fetch(`${viewerUrl}/api/v1/me`, { headers: { cookie: `${cookie}; sid=abc` } });
    expect(lastRequest.headers.cookie).toBe("sid=abc");
    expect(lastRequest.headers.cookie).not.toContain(WEBVIEW_COOKIE);
  });
});

// A Mini App's signed account data rides in the fragment, and the whole handshake rests on
// the browser carrying it across the claim redirect -- something no amount of checking the
// URL we build can show. A real one has to walk it.
describe.skipIf(!chromiumExecutable("free"))("the fragment a Mini App reads its account from", () => {
  it("survives the claim redirect, so the app can still find its initData", async () => {
    const browser = await chromium.launch({
      executablePath: chromiumExecutable("free"),
      headless: true,
    });
    try {
      const signed = `${upstreamUrl}/#tgWebAppData=query_id%3DTEST%26user%3D%257B%2522id%2522%253A1%257D&tgWebAppVersion=7.0`;
      const ticket = issueWebviewTicket(`${upstreamUrl}/`, "app");
      const page = await browser.newPage();
      await page.goto(webviewClaimUrl(ticket.id, signed, viewerUrl), {
        waitUntil: "domcontentloaded",
      });

      expect(page.url()).toContain("#tgWebAppData=");
      expect(await page.evaluate(() => location.hash)).toContain("query_id%3DTEST");
      // On the app's own path, which is what its router needs
      expect(await page.evaluate(() => location.pathname)).toBe("/");
    } finally {
      await browser.close();
    }
  }, 60_000);
});
