import { col } from "../collection";
import type { DialogCacheDoc, MessageCacheDoc } from "../types";

/**
 * The Telegram message and dialog caches.
 *
 * These were SQLite tables with a composite primary key; in Mongo that becomes a computed
 * `_id` of `accountId:chatId` (and `accountId:chatId:msgId` for messages), which is what makes
 * the upserts idempotent without a unique secondary index.
 */

const MSG_CACHE_MAX = 500;

const key = (...parts: Array<string | number>) => parts.join(":");

function msgCol() {
  return col<MessageCacheDoc>("tg_message_cache");
}

function dialogCol() {
  return col<DialogCacheDoc>("tg_dialog_cache");
}

export async function getCachedMessages(
  accountId: number,
  chatId: string,
  limit: number,
  beforeId?: number,
): Promise<string[]> {
  const filter: Record<string, unknown> = { account_id: accountId, chat_id: chatId };
  if (beforeId !== undefined) filter.msg_id = { $lt: beforeId };
  const rows = await msgCol().find(filter).sort({ msg_id: -1 }).limit(limit).toArray();
  return rows.map((r) => r.payload);
}

export async function cacheMessages(
  accountId: number,
  chatId: string,
  msgs: Array<{ id: number; date: number }>,
  stringify: (msg: any) => string,
): Promise<void> {
  if (!msgs.length) return;
  await msgCol().bulkWrite(
    msgs.map((msg) => ({
      updateOne: {
        filter: { _id: key(accountId, chatId, msg.id) },
        update: {
          $set: {
            account_id: accountId,
            chat_id: chatId,
            msg_id: msg.id,
            msg_date: msg.date,
            payload: stringify(msg),
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  await trimCache(accountId, chatId);
}

/**
 * Keeps the most recent MSG_CACHE_MAX messages per chat.
 *
 * SQLite did this in one DELETE with a NOT IN (subquery); Mongo needs the ids worked out
 * first, because there is no way to express "delete all but the top N" in a single statement.
 */
async function trimCache(accountId: number, chatId: string): Promise<void> {
  const keep = await msgCol()
    .find({ account_id: accountId, chat_id: chatId }, { projection: { _id: 1 } })
    .sort({ msg_id: -1 })
    .limit(MSG_CACHE_MAX)
    .toArray();
  if (keep.length < MSG_CACHE_MAX) return;
  await msgCol().deleteMany({
    account_id: accountId,
    chat_id: chatId,
    _id: { $nin: keep.map((r) => r._id) },
  });
}

export async function updateCachedMessageText(
  accountId: number,
  chatId: string,
  msgId: number,
  payloadJson: string,
): Promise<void> {
  await msgCol().updateOne(
    { _id: key(accountId, chatId, msgId) },
    { $set: { payload: payloadJson } },
  );
}

export async function removeCachedMessages(
  accountId: number,
  chatId: string,
  ids: number[],
): Promise<void> {
  if (!ids.length) return;
  await msgCol().deleteMany({
    account_id: accountId,
    chat_id: chatId,
    msg_id: { $in: ids },
  });
}

export async function clearCachedMessages(accountId: number, chatId: string): Promise<void> {
  await msgCol().deleteMany({ account_id: accountId, chat_id: chatId });
}

export async function clearAccountCache(accountId: number): Promise<void> {
  await Promise.all([
    msgCol().deleteMany({ account_id: accountId }),
    dialogCol().deleteMany({ account_id: accountId }),
  ]);
}

export async function maxCachedMessageId(
  accountId: number,
  chatId: string,
): Promise<number> {
  const rows = await msgCol()
    .find({ account_id: accountId, chat_id: chatId }, { projection: { msg_id: 1 } })
    .sort({ msg_id: -1 })
    .limit(1)
    .toArray();
  return rows[0]?.msg_id ?? 0;
}

export async function getCachedDialogs(accountId: number): Promise<string[]> {
  const rows = await dialogCol()
    .find({ account_id: accountId })
    .sort({ sort_order: 1 })
    .toArray();
  return rows.map((r) => r.payload);
}

export async function cacheDialogs(
  accountId: number,
  dialogs: Array<{ chatId: string }>,
  stringify: (dialog: any) => string,
): Promise<void> {
  if (!dialogs.length) return;
  await dialogCol().bulkWrite(
    dialogs.map((dialog, i) => ({
      updateOne: {
        filter: { _id: key(accountId, dialog.chatId) },
        update: {
          $set: {
            account_id: accountId,
            chat_id: dialog.chatId,
            sort_order: i,
            payload: stringify(dialog),
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

export async function removeCachedDialog(accountId: number, chatId: string): Promise<void> {
  await dialogCol().deleteMany({ account_id: accountId, chat_id: chatId });
}

/**
 * Drops cached rows for chats no longer in a full dialog load (deleted chats, left groups).
 * Upserts alone never delete anything, so without this the dialog list only ever grows.
 */
export async function pruneCachedDialogs(
  accountId: number,
  chatIds: string[],
): Promise<void> {
  if (!chatIds.length) return;
  await dialogCol().deleteMany({ account_id: accountId, chat_id: { $nin: chatIds } });
}

export async function cachedDialogIds(accountId: number): Promise<string[]> {
  const rows = await dialogCol()
    .find({ account_id: accountId }, { projection: { chat_id: 1 } })
    .toArray();
  return rows.map((r) => r.chat_id);
}
