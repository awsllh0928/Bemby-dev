import type { Db } from "mongodb";

/** Every collection Bemby uses. Kept in one place because the index definitions, the
 *  migration importer and the id sequence all need the same list. */
export const COLLECTIONS = [
  "settings",
  "tg_accounts",
  "jobs",
  "job_templates",
  "job_logs",
  "ai_suppliers",
  "ai_models",
  "tg_message_cache",
  "tg_dialog_cache",
  "migrations",
  "counters",
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

/**
 * The indexes that replace SQLite's CREATE INDEX statements.
 *
 * MongoDB creates collections implicitly, but not indexes: without these every list view
 * turns into a collection scan, which is the difference between a page that answers and one
 * that does not once there are real job logs in there.
 *
 * `COLLATE NOCASE` has no MongoDB equivalent. Case-insensitive sorting instead uses a
 * collation on the query itself (see listAccounts), which is why no index here can serve it:
 * a MongoDB index only matches a query whose collation is identical.
 */
type IndexSpec = {
  collection: CollectionName;
  name: string;
  keys: Record<string, 1 | -1>;
  unique?: boolean;
};

export const INDEXES: IndexSpec[] = [
  // --- tg_accounts ---
  { collection: "tg_accounts", name: "account_sort_order", keys: { sort_order: 1 } },
  { collection: "tg_accounts", name: "account_disabled", keys: { disabled: 1 } },
  { collection: "tg_accounts", name: "account_phone", keys: { phone_number: 1 } },
  { collection: "tg_accounts", name: "account_auth_status", keys: { auth_status: 1 } },
  { collection: "tg_accounts", name: "account_passkey_present", keys: { passkey: 1 } },

  // --- jobs ---
  {
    collection: "jobs",
    name: "jobs_retired_enabled_name",
    keys: { retired: 1, enabled: 1, name: 1 },
  },
  { collection: "jobs", name: "jobs_template_id", keys: { template_id: 1 } },
  { collection: "jobs", name: "jobs_account_id", keys: { account_id: 1 } },
  { collection: "jobs", name: "jobs_enabled", keys: { enabled: 1 } },
  { collection: "jobs", name: "jobs_job_type", keys: { job_type: 1 } },

  // --- job_templates ---
  { collection: "job_templates", name: "templates_name", keys: { name: 1 } },

  // --- job_logs ---
  { collection: "job_logs", name: "logs_ran_at_desc", keys: { ran_at: -1 } },
  { collection: "job_logs", name: "logs_job_ran_at", keys: { job_id: 1, ran_at: -1 } },
  { collection: "job_logs", name: "logs_retired_ran_at", keys: { retired: 1, ran_at: -1 } },
  { collection: "job_logs", name: "logs_job_status_ran", keys: { job_id: 1, status: 1, ran_at: -1 } },

  // --- ai_* ---
  { collection: "ai_models", name: "models_supplier", keys: { supplier_id: 1 } },

  // --- caches ---
  {
    collection: "tg_message_cache",
    name: "msgcache_account_chat_msg",
    keys: { account_id: 1, chat_id: 1, msg_id: -1 },
  },
  {
    collection: "tg_message_cache",
    name: "msgcache_account_chat",
    keys: { account_id: 1, chat_id: 1 },
  },
  { collection: "tg_dialog_cache", name: "dialogcache_account_sort", keys: { account_id: 1, sort_order: 1 } },
];

/**
 * Creates the indexes above. Safe to call on every connect: createIndexes is idempotent,
 * and an existing index under the same name with different options is the only failure --
 * which is a change someone made by hand, and worth hearing about rather than papering over.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  const byCollection = new Map<CollectionName, IndexSpec[]>();
  for (const spec of INDEXES) {
    const list = byCollection.get(spec.collection) ?? [];
    list.push(spec);
    byCollection.set(spec.collection, list);
  }

  for (const [collection, specs] of byCollection) {
    try {
      await db.collection(collection).createIndexes(
        specs.map((s) => ({
          name: s.name,
          key: s.keys,
          unique: s.unique ?? false,
        })),
      );
    } catch (e) {
      console.error(`[db] could not create indexes on ${collection}:`, e);
    }
  }
}
