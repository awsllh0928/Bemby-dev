import { TelegramClient, Logger } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { fetch as undiciFetch } from "undici";
import type { TgAccount } from "../types";
import { getSettings } from "../db/repos/settings";

export type NotifyEvent = "success" | "failed";

export type NotifyConfig = {
  /** Bot API token from BotFather. The preferred sender: needs no account session. */
  botToken: string | null;
  /** Chat the bot sends to when a job names no target of its own. */
  botTarget: string | null;
  /**
   * Target for the account-session sender, used only when no bot token is set.
   * @deprecated The account-session sender is going away; use botToken + botTarget.
   */
  username: string | null;
  events: string[];
};

export const NOTIFY_BOT_TOKEN_KEY = "notify_bot_token";
export const NOTIFY_BOT_TARGET_KEY = "notify_bot_target";

const BOT_API = "https://api.telegram.org";

/** Normalises username / @username / https://t.me/username to a bare @username peer string. */
export function normaliseNotifyTarget(raw: string): string {
  const s = raw.trim();
  // t.me URL
  const tme = s.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{3,})/);
  if (tme) return `@${tme[1]}`;
  // Strip leading @, re-add to normalise
  const stripped = s.replace(/^@/, "");
  return `@${stripped}`;
}

/**
 * Normalises a Bot API chat target. A bot cannot look a user up by @username -- only a
 * numeric chat id reaches a person, and @name only reaches a public channel or group -- so
 * a numeric id is passed through untouched and everything else is treated as a @name.
 */
export function normaliseBotTarget(raw: string): string {
  const s = raw.trim();
  if (/^-?\d+$/.test(s)) return s;
  return normaliseNotifyTarget(s);
}

/** True when the target is a numeric chat id rather than a public @name. */
export function isChatId(target: string): boolean {
  return /^-?\d+$/.test(target.trim());
}

export async function getNotifyConfig(): Promise<NotifyConfig> {
  const map = await getSettings([
    "notify_tg_username",
    "notify_tg_events",
    NOTIFY_BOT_TOKEN_KEY,
    NOTIFY_BOT_TARGET_KEY,
  ]);
  let events: string[] = ["failed"];
  try {
    if (map.notify_tg_events) events = JSON.parse(map.notify_tg_events);
  } catch {
    /* ignore */
  }
  const raw = map.notify_tg_username?.trim();
  const botTarget = map[NOTIFY_BOT_TARGET_KEY]?.trim();
  return {
    botToken: map[NOTIFY_BOT_TOKEN_KEY]?.trim() || null,
    botTarget: botTarget ? normaliseBotTarget(botTarget) : null,
    username: raw ? normaliseNotifyTarget(raw) : null,
    events,
  };
}

/** Returns the last 4 chars of a bot token behind its public numeric id: 12345678:****wXyZ. */
export function maskBotToken(token: string): string {
  if (!token) return "";
  const id = token.split(":")[0] ?? "";
  const tail = token.length > 4 ? token.slice(-4) : "";
  return `${id}:****${tail}`;
}

type BotApiResult<T> = { ok: true; result: T } | { ok: false; error: string };

/** One Bot API call. Never throws: a transport failure comes back as ok:false. */
async function botApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<BotApiResult<T>> {
  try {
    const res = await undiciFetch(`${BOT_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!json?.ok) {
      return { ok: false, error: json?.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, result: json.result as T };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type BotInfo = { id: number; username?: string; first_name?: string };

/** getMe -- confirms the token is live and names the bot it belongs to. */
export function getBotInfo(token: string): Promise<BotApiResult<BotInfo>> {
  return botApi<BotInfo>(token, "getMe");
}

export type BotChat = {
  id: number;
  type: string;
  title: string;
};

/**
 * Chats the bot has heard from recently, via getUpdates. This is how an operator finds the
 * numeric chat id to notify: message the bot, then read the id back off this list. Only
 * works while no webhook is set and only covers updates Telegram still holds (~24h).
 */
export async function recentBotChats(token: string): Promise<BotApiResult<BotChat[]>> {
  const res = await botApi<Array<Record<string, unknown>>>(token, "getUpdates", {
    limit: 100,
    allowed_updates: [],
  });
  if (!res.ok) return res;

  const chats = new Map<number, BotChat>();
  for (const update of res.result) {
    // Every update that carries a chat -- message, edited_message, channel_post,
    // my_chat_member -- holds it under the same `chat` key one level down.
    for (const value of Object.values(update)) {
      const chat = (value as { chat?: RawChat } | null)?.chat;
      if (!chat || typeof chat.id !== "number" || chats.has(chat.id)) continue;
      chats.set(chat.id, { id: chat.id, type: chat.type, title: chatTitle(chat) });
    }
  }
  return { ok: true, result: [...chats.values()] };
}

type RawChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
};

function chatTitle(chat: RawChat): string {
  const name = [chat.first_name, chat.username ? `@${chat.username}` : null]
    .filter(Boolean)
    .join(" ");
  return chat.title || name || String(chat.id);
}

/** Sends a message as the bot. Rejects with the Bot API's own description on failure. */
export async function sendBotNotify(
  token: string,
  target: string,
  message: string,
): Promise<void> {
  const res = await botApi(token, "sendMessage", {
    chat_id: normaliseBotTarget(target),
    text: message,
    disable_web_page_preview: true,
  });
  if (!res.ok) throw new Error(res.error);
}

/**
 * Sends a notification via the given account's session.
 * target defaults to 'me' (Saved Messages).
 * Fire-and-forget -- callers should .catch() any rejection.
 *
 * @deprecated Superseded by {@link sendBotNotify}, and due for removal in a future
 * release. Sending as the account spins up a full MTProto client per notification and
 * only works when that account is authenticated; a bot token has neither limitation.
 */
export async function sendTgNotify(
  account: TgAccount,
  message: string,
  target = "me",
): Promise<void> {
  if (!account.sessionString || !account.apiId || !account.apiHash) return;

  const client = new TelegramClient(
    new StringSession(account.sessionString),
    account.apiId,
    account.apiHash,
    {
      connectionRetries: 3,
      autoReconnect: false,
      baseLogger: new Logger(LogLevel.NONE),
    },
  );

  try {
    await client.connect();
    await client.sendMessage(target, { message });
  } finally {
    // destroy, not disconnect -- only destroy stops the GramJS ping loop (issue #14)
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
  }
}

/**
 * The one place a finished job's notification is decided and sent. The bot is preferred
 * because it needs no account session, so a job whose account is unauthenticated -- or a
 * job type that has no account at all -- still notifies. Without a bot token this falls
 * back to sending from the job's own account, which is what installs did before tokens.
 * That fallback is deprecated and will be removed, so it warns each time it is used.
 *
 * `target` is the per-job override; the global default applies when it is absent.
 * Never throws: a failed notification must not fail the run that triggered it.
 */
export async function notifyJobEvent(
  event: NotifyEvent,
  message: string,
  account?: TgAccount | null,
  target?: string | null,
): Promise<void> {
  const cfg = await getNotifyConfig();
  if (!cfg.events.includes(event)) return;

  if (cfg.botToken) {
    const chat = target?.trim() || cfg.botTarget;
    if (!chat) return;
    await sendBotNotify(cfg.botToken, chat, message).catch((e) =>
      console.warn("[notify] bot notification failed:", e),
    );
    return;
  }

  // Deprecated sender. A failure still went to Saved Messages when no target was set.
  if (!account?.sessionString) return;
  const legacyTarget = target?.trim() || cfg.username;
  if (!legacyTarget && event !== "failed") return;
  console.warn(
    "[notify] sending as the account is deprecated and will be removed in a future release -- set a notification bot token in Settings",
  );
  await sendTgNotify(account, message, legacyTarget ?? "me").catch((e) =>
    console.warn("[notify] TG notification failed:", e),
  );
}

export function buildFailureMessage(
  jobName: string,
  jobType: string,
  errorMessage: string,
): string {
  return [
    "❌ Bemby job failed",
    "",
    `Job: ${jobName}`,
    `Type: ${jobType}`,
    `Error: ${errorMessage}`,
  ].join("\n");
}

export function buildSuccessMessage(jobName: string, jobType: string): string {
  return [
    "✅ Bemby job succeeded",
    "",
    `Job: ${jobName}`,
    `Type: ${jobType}`,
  ].join("\n");
}
