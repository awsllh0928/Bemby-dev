const undiciFetch = vi.fn();
vi.mock("undici", () => ({ fetch: (...args: unknown[]) => undiciFetch(...args) }));

const sendMessage = vi.fn();
const destroy = vi.fn();
vi.mock("telegram", () => ({
  TelegramClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    sendMessage,
    destroy,
  })),
  Logger: vi.fn(),
}));
vi.mock("telegram/extensions/Logger", () => ({ LogLevel: { NONE: 0 } }));
vi.mock("telegram/sessions", () => ({ StringSession: vi.fn() }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSettings } from "../db/repos/settings";
import { useTestDb } from "./helpers/db";
import {
  normaliseNotifyTarget,
  normaliseBotTarget,
  maskBotToken,
  getNotifyConfig,
  notifyJobEvent,
  recentBotChats,
  sendBotNotify,
  buildFailureMessage,
  buildSuccessMessage,
} from "../jobs/notify";
import type { TgAccount } from "../types";

const account = {
  id: 1,
  name: "acct",
  phoneNumber: "+61400000000",
  apiId: 123,
  apiHash: "hash",
  sessionString: "session",
  authStatus: "authenticated",
} as unknown as TgAccount;

/** A Bot API 200 with `ok: true` and the given result. */
function botOk(result: unknown) {
  return { status: 200, json: async () => ({ ok: true, result }) };
}

// Notification settings are read through the settings repository, so a real database
// replaces the rows this file used to hand the mocked prepare().
useTestDb();

async function seedSettings(rows: Array<{ key: string; value: string }>) {
  await setSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

beforeEach(() => {
  undiciFetch.mockReset();
  sendMessage.mockReset();
  destroy.mockReset();
});

// ---------------------------------------------------------------------------
// normaliseNotifyTarget
// ---------------------------------------------------------------------------

describe("normaliseNotifyTarget", () => {
  it("adds @ to a bare username", () => {
    expect(normaliseNotifyTarget("myuser")).toBe("@myuser");
  });

  it("keeps a single @ on an already-prefixed username", () => {
    expect(normaliseNotifyTarget("@myuser")).toBe("@myuser");
  });

  it("converts a full t.me URL", () => {
    expect(normaliseNotifyTarget("https://t.me/myuser")).toBe("@myuser");
  });

  it("converts a t.me URL without the scheme", () => {
    expect(normaliseNotifyTarget("t.me/myuser")).toBe("@myuser");
  });

  it("converts an http t.me URL", () => {
    expect(normaliseNotifyTarget("http://t.me/myuser")).toBe("@myuser");
  });

  it("trims surrounding whitespace before normalising", () => {
    expect(normaliseNotifyTarget("  @myuser  ")).toBe("@myuser");
  });
});

// ---------------------------------------------------------------------------
// normaliseBotTarget / maskBotToken
// ---------------------------------------------------------------------------

describe("normaliseBotTarget", () => {
  it("passes a numeric chat id through untouched", () => {
    expect(normaliseBotTarget("123456789")).toBe("123456789");
  });

  it("keeps the sign on a group chat id", () => {
    expect(normaliseBotTarget("-1001234567890")).toBe("-1001234567890");
  });

  it("treats anything else as a public @name", () => {
    expect(normaliseBotTarget("mychannel")).toBe("@mychannel");
    expect(normaliseBotTarget("https://t.me/mychannel")).toBe("@mychannel");
  });
});

// Deliberately shorter than a real token's 35-character secret: a fixture shaped like the
// real thing trips GitHub's secret scanner, and none of this depends on the length.
const FAKE_TOKEN = "123456789:test-token-not-a-secret";

describe("maskBotToken", () => {
  it("keeps the public bot id and the last 4 chars", () => {
    expect(maskBotToken(FAKE_TOKEN)).toBe("123456789:****cret");
  });

  it("returns an empty string for no token", () => {
    expect(maskBotToken("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getNotifyConfig
// ---------------------------------------------------------------------------

describe("getNotifyConfig", () => {
  it("defaults to notifying on failure only, with nothing configured", async () => {
    expect(await getNotifyConfig()).toEqual({
      botToken: null,
      botTarget: null,
      username: null,
      events: ["failed"],
    });
  });

  it("reads the bot token and normalises the default target", async () => {
    await seedSettings([
      { key: "notify_bot_token", value: "  123:abc  " },
      { key: "notify_bot_target", value: " t.me/mychannel " },
      { key: "notify_tg_events", value: '["failed","success"]' },
    ]);
    expect(await getNotifyConfig()).toEqual({
      botToken: "123:abc",
      botTarget: "@mychannel",
      username: null,
      events: ["failed", "success"],
    });
  });
});

// ---------------------------------------------------------------------------
// sendBotNotify / recentBotChats
// ---------------------------------------------------------------------------

describe("sendBotNotify", () => {
  it("posts the target and text to the token's sendMessage endpoint", async () => {
    undiciFetch.mockResolvedValue(botOk({ message_id: 1 }));
    await sendBotNotify("123:abc", "t.me/mychannel", "hello");

    const [url, init] = undiciFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(JSON.parse(init.body)).toMatchObject({
      chat_id: "@mychannel",
      text: "hello",
    });
  });

  it("rejects with the Bot API's own description", async () => {
    undiciFetch.mockResolvedValue({
      status: 400,
      json: async () => ({ ok: false, description: "chat not found" }),
    });
    await expect(sendBotNotify("123:abc", "999", "hello")).rejects.toThrow(
      "chat not found",
    );
  });

  it("rejects when the host cannot reach the Bot API", async () => {
    undiciFetch.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    await expect(sendBotNotify("123:abc", "999", "hello")).rejects.toThrow(
      "getaddrinfo ENOTFOUND",
    );
  });
});

describe("recentBotChats", () => {
  it("collects each distinct chat once, whichever update carried it", async () => {
    undiciFetch.mockResolvedValue(
      botOk([
        { update_id: 1, message: { chat: { id: 42, type: "private", first_name: "Sam", username: "sam" } } },
        { update_id: 2, message: { chat: { id: 42, type: "private", first_name: "Sam" } } },
        { update_id: 3, channel_post: { chat: { id: -100, type: "channel", title: "Alerts" } } },
      ]),
    );
    const res = await recentBotChats("123:abc");
    expect(res.ok).toBe(true);
    expect(res.ok && res.result).toEqual([
      { id: 42, type: "private", title: "Sam @sam" },
      { id: -100, type: "channel", title: "Alerts" },
    ]);
  });

  it("reports the failure rather than throwing", async () => {
    undiciFetch.mockResolvedValue({
      status: 401,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    });
    expect(await recentBotChats("bad")).toEqual({ ok: false, error: "Unauthorized" });
  });
});

// ---------------------------------------------------------------------------
// notifyJobEvent -- which sender is used, and when nothing is sent at all
// ---------------------------------------------------------------------------

describe("notifyJobEvent", () => {
  it("sends as the bot when a token is stored, ignoring the account", async () => {
    await seedSettings([
      { key: "notify_bot_token", value: "123:abc" },
      { key: "notify_bot_target", value: "42" },
    ]);
    undiciFetch.mockResolvedValue(botOk({ message_id: 1 }));

    await notifyJobEvent("failed", "boom", null);

    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(undiciFetch.mock.calls[0][1].body)).toMatchObject({
      chat_id: "42",
      text: "boom",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("prefers a per-job target over the global default", async () => {
    await seedSettings([
      { key: "notify_bot_token", value: "123:abc" },
      { key: "notify_bot_target", value: "42" },
    ]);
    undiciFetch.mockResolvedValue(botOk({ message_id: 1 }));

    await notifyJobEvent("failed", "boom", null, " 777 ");

    expect(JSON.parse(undiciFetch.mock.calls[0][1].body)).toMatchObject({
      chat_id: "777",
    });
  });

  it("sends nothing when the event is not one of the configured ones", async () => {
    await seedSettings([
      { key: "notify_bot_token", value: "123:abc" },
      { key: "notify_bot_target", value: "42" },
      { key: "notify_tg_events", value: '["failed"]' },
    ]);

    await notifyJobEvent("success", "done", account);

    expect(undiciFetch).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends nothing when a token is stored but no target is", async () => {
    await seedSettings([{ key: "notify_bot_token", value: "123:abc" }]);

    await notifyJobEvent("failed", "boom", account);

    expect(undiciFetch).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("swallows a bot send failure so the run is not affected", async () => {
    await seedSettings([
      { key: "notify_bot_token", value: "123:abc" },
      { key: "notify_bot_target", value: "42" },
    ]);
    undiciFetch.mockRejectedValue(new Error("network down"));

    await expect(notifyJobEvent("failed", "boom", null)).resolves.toBeUndefined();
  });

  it("falls back to the account session when no bot token is stored", async () => {
    await seedSettings([{ key: "notify_tg_username", value: "someone" }]);

    await notifyJobEvent("failed", "boom", account);

    expect(undiciFetch).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith("@someone", { message: "boom" });
  });

  it("warns that the account sender is deprecated whenever it is used", async () => {
    await seedSettings([{ key: "notify_tg_username", value: "someone" }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await notifyJobEvent("failed", "boom", account);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
    warn.mockRestore();
  });

  it("does not warn about deprecation when the bot sends", async () => {
    await seedSettings([
      { key: "notify_bot_token", value: "123:abc" },
      { key: "notify_bot_target", value: "42" },
    ]);
    undiciFetch.mockResolvedValue(botOk({ message_id: 1 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await notifyJobEvent("failed", "boom", account);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still sends a failure to Saved Messages when the fallback has no target", async () => {
    await notifyJobEvent("failed", "boom", account);
    expect(sendMessage).toHaveBeenCalledWith("me", { message: "boom" });
  });

  it("does not send a success through the fallback with no target configured", async () => {
    await seedSettings([{ key: "notify_tg_events", value: '["success"]' }]);

    await notifyJobEvent("success", "done", account);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends nothing through the fallback when the account has no session", async () => {
    await seedSettings([{ key: "notify_tg_username", value: "someone" }]);

    await notifyJobEvent("failed", "boom", { ...account, sessionString: null });

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildFailureMessage
// ---------------------------------------------------------------------------

describe("buildFailureMessage", () => {
  it("includes the job name, type, and error message", () => {
    const msg = buildFailureMessage("Daily Checkin", "checkin", "Timeout");
    expect(msg).toContain("Daily Checkin");
    expect(msg).toContain("checkin");
    expect(msg).toContain("Timeout");
  });

  it("has the correct format", () => {
    const msg = buildFailureMessage("Job A", "custom", "Something went wrong");
    expect(msg).toBe(
      "❌ Bemby job failed\n\nJob: Job A\nType: custom\nError: Something went wrong",
    );
  });
});

// ---------------------------------------------------------------------------
// buildSuccessMessage
// ---------------------------------------------------------------------------

describe("buildSuccessMessage", () => {
  it("includes the job name and type", () => {
    const msg = buildSuccessMessage("Daily Checkin", "checkin");
    expect(msg).toContain("Daily Checkin");
    expect(msg).toContain("checkin");
  });

  it("has the correct format", () => {
    const msg = buildSuccessMessage("Job A", "custom");
    expect(msg).toBe("✅ Bemby job succeeded\n\nJob: Job A\nType: custom");
  });
});
