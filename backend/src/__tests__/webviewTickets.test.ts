// A ticket is the whole credential the viewer proxy runs on, so what it does and does not
// authorise is the boundary between a viewer and an open relay.

import { describe, it, expect } from "vitest";
import {
  issueWebviewTicket,
  registrableDomain,
  resolveWebviewTicket,
  sameParty,
  ticketAllowsUrl,
} from "../tg/webviewTickets";

describe("registrableDomain", () => {
  it("takes the last two labels under an ordinary TLD", () => {
    expect(registrableDomain("app.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("a.b.c.example.com")).toBe("example.com");
  });

  it("takes three labels under a country second-level suffix", () => {
    expect(registrableDomain("api.shop.com.au")).toBe("shop.com.au");
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("mail.dept.ac.nz")).toBe("dept.ac.nz");
    expect(registrableDomain("x.example.co.jp")).toBe("example.co.jp");
  });

  it("does not treat a public suffix as something anyone owns", () => {
    expect(registrableDomain("com.au")).toBe("com.au");
    expect(registrableDomain("co.uk")).toBe("co.uk");
  });

  it("is case and trailing-dot insensitive", () => {
    expect(registrableDomain("API.Shop.COM.AU.")).toBe("shop.com.au");
  });
});

describe("sameParty", () => {
  it("matches the domain itself and anything beneath it", () => {
    expect(sameParty("example.com", "example.com")).toBe(true);
    expect(sameParty("api.example.com", "example.com")).toBe(true);
  });

  it("does not match a name that merely ends the same way", () => {
    expect(sameParty("notexample.com", "example.com")).toBe(false);
    expect(sameParty("example.com.evil.test", "example.com")).toBe(false);
  });
});

describe("ticketAllowsUrl", () => {
  it("allows the exact origin it was issued for", () => {
    const ticket = issueWebviewTicket("https://app.example.com/start", "app");
    expect(ticketAllowsUrl(ticket, "https://app.example.com/anything?q=1")).toBe(true);
  });

  it("allows a sibling host on the same registrable domain, since apps split page and API", () => {
    const ticket = issueWebviewTicket("https://app.example.com/start", "app");
    expect(ticketAllowsUrl(ticket, "https://api.example.com/v1/me")).toBe(true);
  });

  it("refuses another party under a multi-label public suffix", () => {
    // The old last-two-labels rule read this as "com.au" and let the whole suffix through
    const ticket = issueWebviewTicket("https://app.shop.com.au/start", "app");
    expect(ticketAllowsUrl(ticket, "https://api.shop.com.au/v1")).toBe(true);
    expect(ticketAllowsUrl(ticket, "https://bank.com.au/login")).toBe(false);
    expect(ticketAllowsUrl(ticket, "https://anything.com.au/")).toBe(false);
  });

  it("refuses an unrelated site and a non-http scheme", () => {
    const ticket = issueWebviewTicket("https://app.example.com/start", "app");
    expect(ticketAllowsUrl(ticket, "https://evil.test/")).toBe(false);
    expect(ticketAllowsUrl(ticket, "file:///etc/passwd")).toBe(false);
    expect(ticketAllowsUrl(ticket, "not a url")).toBe(false);
  });
});

describe("issueWebviewTicket", () => {
  it("refuses a scheme that cannot be proxied", () => {
    expect(() => issueWebviewTicket("file:///etc/passwd", "page")).toThrow(/http/i);
  });

  it("mints unguessable ids that resolve back to the ticket", () => {
    const a = issueWebviewTicket("https://example.com/", "page");
    const b = issueWebviewTicket("https://example.com/", "page");
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThanOrEqual(32);
    expect(resolveWebviewTicket(a.id)?.origin).toBe("https://example.com");
    expect(resolveWebviewTicket("nope")).toBeUndefined();
  });
});
