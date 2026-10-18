// Tests for the notification bot settings: the token never leaves the server in full,
// blank keeps the stored one, and the three /notify endpoints answer as the panel expects.

vi.mock("../scheduler", () => ({
  refreshScheduler: vi.fn(),
  purgeOldLogs: vi.fn(),
}));
vi.mock("../jobs/runner", () => ({ parseTgProxy: vi.fn() }));
vi.mock("socks", () => ({ SocksClient: { createConnection: vi.fn() } }));

// Only the calls that would reach Telegram are replaced; the config reader and the mask
// stay real, since they are what these tests are about.
const { getBotInfo, recentBotChats, sendBotNotify } = vi.hoisted(() => ({
  getBotInfo: vi.fn(),
  recentBotChats: vi.fn(),
  sendBotNotify: vi.fn(),
}));
vi.mock("../jobs/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jobs/notify")>()),
  getBotInfo,
  recentBotChats,
  sendBotNotify,
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import settingsRouter, { ALLOWED_KEYS, CLIENT_HIDDEN_KEYS } from "../routes/settings";
import { getSetting, setSettings } from "../db/repos/settings";
import { useTestDb } from "./helpers/db";

// The settings panel reads and writes the settings collection, so this runs against a real
// database rather than a stubbed `prepare` whose `run` calls used to be asserted on.
useTestDb();

// Deliberately shorter than a real token's 35-character secret: a fixture shaped like the
// real thing trips GitHub's secret scanner, and nothing here depends on the length.
const TOKEN = "123456789:test-token-not-a-secret";

/** Pulls a route handler out of the Express router so it can be called directly. */
function routeHandler(method: string, path: string) {
  const layer = (settingsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle as (req: any, res: any) => any;
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

const getSettings = routeHandler("get", "/");
const putSettings = routeHandler("put", "/");
const getBot = routeHandler("get", "/notify/bot");
const getChats = routeHandler("get", "/notify/bot/chats");
const postTest = routeHandler("post", "/notify/bot/test");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notification bot settings", () => {
  it("accepts the token and the default target as settings keys", () => {
    expect(ALLOWED_KEYS).toContain("notify_bot_token");
    expect(ALLOWED_KEYS).toContain("notify_bot_target");
  });

  it("never sends the raw token to the client, only a mask and a flag", async () => {
    await setSettings({ notify_bot_token: TOKEN, notify_bot_target: "42" });
    const res = makeRes();
    await getSettings({}, res);

    expect(CLIENT_HIDDEN_KEYS.has("notify_bot_token")).toBe(true);
    expect(res.body.notify_bot_token).toBeUndefined();
    expect(res.body.notify_bot_token_masked).toBe("123456789:****cret");
    expect(res.body.notify_bot_configured).toBe("true");
    // The target is not a secret: the panel needs it to fill the field back in
    expect(res.body.notify_bot_target).toBe("42");
  });

  it("reports no bot when no token is stored", async () => {
    const res = makeRes();
    await getSettings({}, res);
    expect(res.body.notify_bot_configured).toBe("false");
    expect(res.body.notify_bot_token_masked).toBe("");
  });

  it("stores a token that was typed in", async () => {
    await putSettings({ body: { notify_bot_token: TOKEN } }, makeRes());
    expect(await getSetting("notify_bot_token")).toBe(TOKEN);
  });

  it("leaves the stored token alone when the mask is sent back", async () => {
    await setSettings({ notify_bot_token: TOKEN });

    await putSettings(
      { body: { notify_bot_token: "123456789:****cret", notify_bot_target: "42" } },
      makeRes(),
    );

    expect(await getSetting("notify_bot_token")).toBe(TOKEN);
    expect(await getSetting("notify_bot_target")).toBe("42");
  });
});

describe("GET /notify/bot", () => {
  it("says nothing is configured when no token is stored", async () => {
    const res = makeRes();
    await getBot({}, res);
    expect(res.body).toEqual({ configured: false });
    expect(getBotInfo).not.toHaveBeenCalled();
  });

  it("names the bot the stored token belongs to", async () => {
    await setSettings({ notify_bot_token: TOKEN });
    getBotInfo.mockResolvedValue({
      ok: true,
      result: { id: 7, username: "mybot", first_name: "My Bot" },
    });

    const res = makeRes();
    await getBot({}, res);

    expect(getBotInfo).toHaveBeenCalledWith(TOKEN);
    expect(res.body).toEqual({
      configured: true,
      ok: true,
      id: 7,
      username: "mybot",
      name: "My Bot",
    });
  });

  it("passes Telegram's rejection through so a dead token is visible", async () => {
    await setSettings({ notify_bot_token: TOKEN });
    getBotInfo.mockResolvedValue({ ok: false, error: "Unauthorized" });

    const res = makeRes();
    await getBot({}, res);

    expect(res.body).toEqual({ configured: true, ok: false, error: "Unauthorized" });
  });
});

describe("GET /notify/bot/chats", () => {
  it("refuses when there is no token to ask with", async () => {
    const res = makeRes();
    await getChats({ query: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns the chats the bot has heard from", async () => {
    await setSettings({ notify_bot_token: TOKEN });
    recentBotChats.mockResolvedValue({
      ok: true,
      result: [{ id: 42, type: "private", title: "Sam" }],
    });

    const res = makeRes();
    await getChats({ query: {} }, res);

    expect(res.body).toEqual({
      ok: true,
      chats: [{ id: 42, type: "private", title: "Sam" }],
    });
  });

  it("answers 502 when Telegram would not say", async () => {
    await setSettings({ notify_bot_token: TOKEN });
    recentBotChats.mockResolvedValue({ ok: false, error: "Unauthorized" });

    const res = makeRes();
    await getChats({ query: {} }, res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ ok: false, error: "Unauthorized" });
  });
});

describe("POST /notify/bot/test", () => {
  it("sends to the stored default target", async () => {
    await setSettings({ notify_bot_token: TOKEN, notify_bot_target: "42" });
    sendBotNotify.mockResolvedValue(undefined);

    const res = makeRes();
    await postTest({ body: {} }, res);

    expect(sendBotNotify).toHaveBeenCalledWith(TOKEN, "42", expect.any(String));
    expect(res.body).toEqual({ ok: true });
  });

  it("prefers a target supplied in the request, so an unsaved one can be tried", async () => {
    await setSettings({ notify_bot_token: TOKEN, notify_bot_target: "42" });
    sendBotNotify.mockResolvedValue(undefined);

    await postTest({ body: { target: "777" } }, makeRes());

    expect(sendBotNotify).toHaveBeenCalledWith(TOKEN, "777", expect.any(String));
  });

  it("refuses when no target is configured or supplied", async () => {
    await setSettings({ notify_bot_token: TOKEN });

    const res = makeRes();
    await postTest({ body: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(sendBotNotify).not.toHaveBeenCalled();
  });

  it("reports the send failure rather than claiming success", async () => {
    await setSettings({ notify_bot_token: TOKEN, notify_bot_target: "42" });
    sendBotNotify.mockRejectedValue(new Error("chat not found"));

    const res = makeRes();
    await postTest({ body: {} }, res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ ok: false, error: "chat not found" });
  });
});
