import { col } from "../collection";
import type { SettingDoc } from "../types";

/**
 * The settings key/value store, now a collection with `_id` as the key.
 *
 * Everything that used to be read through `SELECT value FROM settings WHERE key = ?` comes
 * through here, which is why all three shapes survive: single reads for the many `getSetting`
 * call sites, `getMany` for the handful of files that loaded several keys at once (they used
 * `WHERE key IN (...)`), and `all` for the settings panel, which returned the whole table.
 */

const MIGRATION_PREFIX = "migration:";

function settingsCol() {
  return col<SettingDoc>("settings");
}

export async function allSettings(): Promise<Record<string, string>> {
  const rows = await settingsCol().find({}).toArray();
  return Object.fromEntries(rows.map((r) => [r._id as string, r.value]));
}

export async function getSetting(key: string): Promise<string | undefined> {
  const row = await settingsCol().findOne({ _id: key });
  return row?.value;
}

export async function getSettings(keys: string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
  const rows = await settingsCol().find({ _id: { $in: keys } }).toArray();
  const found = new Map(rows.map((r) => [r._id as string, r.value]));
  return Object.fromEntries(keys.map((k) => [k, found.get(k)]).filter(([, v]) => v !== undefined) as Array<[string, string]>);
}

export async function setSetting(key: string, value: string): Promise<void> {
  await settingsCol().updateOne(
    { _id: key },
    { $set: { value: String(value) } },
    { upsert: true },
  );
}

export async function setSettings(values: Record<string, string>): Promise<void> {
  const entries = Object.entries(values);
  if (!entries.length) return;
  await settingsCol().bulkWrite(
    entries.map(([key, value]) => ({
      updateOne: {
        filter: { _id: key },
        update: { $set: { value: String(value) } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

export async function deleteSetting(key: string): Promise<void> {
  await settingsCol().deleteOne({ _id: key });
}

/**
 * One-shot data fix-ups. SQLite kept these keys in the same table as real settings, under a
 * `migration:` prefix; that convention is carried over unchanged so an install imported from
 * SQLite keeps its history instead of re-running every fix again.
 */
export async function hasRun(id: string): Promise<boolean> {
  const row = await settingsCol().findOne({ _id: `${MIGRATION_PREFIX}${id}` });
  return Boolean(row);
}

export async function markRun(id: string): Promise<void> {
  await setSetting(`${MIGRATION_PREFIX}${id}`, "1");
}

/**
 * Runs a data fix-up at most once per database.
 *
 * Any throw is logged rather than propagated: a fix-up that fails should not take Bemby down
 * at boot, which is what an exception escaping during startup did before.
 */
export async function runOnce(id: string, fn: () => Promise<void>): Promise<void> {
  try {
    if (await hasRun(id)) return;
    await fn();
    await markRun(id);
  } catch (e) {
    console.error(`[db] migration ${id} failed:`, e);
  }
}
