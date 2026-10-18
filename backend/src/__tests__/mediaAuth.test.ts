// Inline chat media is loaded by the browser itself, which cannot set an Authorization
// header, so those routes authenticate with a short-lived media ticket. What matters is
// where the guard sits: the main tg-client router is mounted behind `requireAuth`, and
// mounting the media route behind it too meant the outer guard refused every image before
// the ticket was ever looked at. These pin the arrangement that fixed it.

vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
  },
}));

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import jwt from "jsonwebtoken";
import { requireAuth, requireMediaAuth } from "../middleware/auth";
import { issueMediaTicket, isValidMediaTicket, resetMediaTickets } from "../auth/mediaTickets";

const TEST_SECRET = "test-only-secret-do-not-use-in-prod";

let server: http.Server;
let base = "";

beforeAll(async () => {
  process.env.JWT_SECRET = TEST_SECRET;

  // Mounted exactly as server.ts does: media router first, then the guarded one
  const mediaRouter = express.Router();
  mediaRouter.get("/:accountId/photo", requireMediaAuth, (_req, res) => {
    res.json({ route: "photo" });
  });
  const router = express.Router();
  router.get("/:accountId/dialogs", (_req, res) => {
    res.json({ route: "dialogs" });
  });

  const app = express();
  app.use("/api/tg-client", mediaRouter);
  app.use("/api/tg-client", requireAuth, router);

  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tg-client`;
});

afterAll(() => server?.close());

beforeEach(() => resetMediaTickets());

const status = (path: string, init?: RequestInit) =>
  fetch(`${base}${path}`, init).then((r) => r.status);

describe("media ticket auth", () => {
  it("serves media to a request holding only a ticket", async () => {
    const { ticket } = issueMediaTicket();
    expect(await status(`/5/photo?ticket=${ticket}`)).toBe(200);
  });

  it("refuses a bogus, empty or absent ticket", async () => {
    expect(await status("/5/photo?ticket=not-a-ticket")).toBe(401);
    expect(await status("/5/photo?ticket=")).toBe(401);
    expect(await status("/5/photo")).toBe(401);
  });

  it("still accepts a normal session token on the media route", async () => {
    const token = jwt.sign({ sub: "admin", typ: "auth", ep: 0 }, TEST_SECRET, { expiresIn: "1h" });
    expect(
      await status("/5/photo", { headers: { authorization: `Bearer ${token}` } }),
    ).toBe(200);
  });

  it("does not let a media ticket reach the rest of the API", async () => {
    // The ticket buys inline media and nothing else; the guarded router is untouched by it
    const { ticket } = issueMediaTicket();
    expect(await status(`/5/dialogs?ticket=${ticket}`)).toBe(401);
  });

  it("serves the guarded router normally to a session token", async () => {
    const token = jwt.sign({ sub: "admin", typ: "auth", ep: 0 }, TEST_SECRET, { expiresIn: "1h" });
    expect(
      await status("/5/dialogs", { headers: { authorization: `Bearer ${token}` } }),
    ).toBe(200);
  });
});

describe("issueMediaTicket", () => {
  it("mints unguessable tickets that validate and are reusable", async () => {
    const a = issueMediaTicket();
    const b = issueMediaTicket();
    expect(a.ticket).not.toBe(b.ticket);
    expect(a.ticket.length).toBeGreaterThanOrEqual(32);
    // Reusable on purpose: one page renders many images from one ticket
    expect(isValidMediaTicket(a.ticket)).toBe(true);
    expect(isValidMediaTicket(a.ticket)).toBe(true);
    expect(a.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects an expired ticket", () => {
    const { ticket } = issueMediaTicket();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    expect(isValidMediaTicket(ticket)).toBe(false);
    vi.restoreAllMocks();
  });
});
