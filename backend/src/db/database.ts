import type { Db } from "mongodb";

import { getDb, getDbState, peekDb, closeDb, isDbReady, onDbReady, initDb } from "./mongo/client";
import { ensureIndexes } from "./mongo/schema";
import { DEFAULT_DB_NAME } from "./mongo/config";
import { col } from "./collection";
import { getSetting } from "./repos/settings";

export {
  closeDb,
  getDb,
  getDbState,
  initDb,
  isDbReady,
  onDbReady,
  peekDb,
  ensureIndexes,
  DEFAULT_DB_NAME,
  col,
};

export const FALLBACK_TIMEZONE = "Australia/Sydney";

/** Returns the default_timezone setting, or the built-in fallback when unset. */
export async function getDefaultTimezone(): Promise<string> {
  try {
    const value = await getSetting("default_timezone");
    return value || FALLBACK_TIMEZONE;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

/** Returns the global fallback TG API credentials, or null if not configured. */
export async function getDefaultTgApiCredentials(): Promise<{
  apiId: number;
  apiHash: string;
} | null> {
  try {
    const apiId = Number(await getSetting("default_tg_api_id"));
    const apiHash = (await getSetting("default_tg_api_hash")) ?? "";
    if (!apiId || !apiHash) return null;
    return { apiId, apiHash };
  } catch {
    return null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** The raw database handle when it exists, or null. For code that can degrade gracefully. */
export function tryDb(): Db | null {
  return peekDb();
}
