import fs from "fs";
import path from "path";
import type { Db } from "mongodb";

import { seedCounterAbove } from "./ids";

/**
 * One-way import of an existing install's SQLite database into MongoDB.
 *
 * Anyone who has run Bemby before this build has their accounts, jobs and history in
 * `data/bemby.db`. Throwing that away on upgrade would be indefensible, so the first thing
 * the panel offers on a fresh MongoDB connection is "import existing data".
 *
 * better-sqlite3 is imported lazily rather than at module load: after the move it is needed
 * by this one screen and by nothing else, and a native module that must build successfully
 * should not sit between Bemby and booting.
 */
export type ImportResult = {
  ok: boolean;
  tables: Record<string, number>;
  skipped: string[];
  message: string;
};

/** Old SQLite table -> [collection, primary key column] */
const TABLES: Array<[string, string, string]> = [
  ["settings", "settings", "key"],
  ["tg_accounts", "tg_accounts", "id"],
  ["jobs", "jobs", "id"],
  ["job_templates", "job_templates", "id"],
  ["job_logs", "job_logs", "id"],
  ["ai_suppliers", "ai_suppliers", "id"],
  ["ai_models", "ai_models", "id"],
  ["tg_message_cache", "tg_message_cache", "rowid"],
  ["tg_dialog_cache", "tg_dialog_cache", "rowid"],
];

function defaultSqlitePath(): string {
  return (
    process.env.DB_PATH ?? path.resolve(process.cwd(), "data/bemby.db")
  );
}

/** Row-column quirks worth fixing on the way in, since the old schema was looser than the
 *  shape the rest of Bemby now assumes. */
function normalise(collection: string, row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  // job_logs.retired was INTEGER 0/1; the Mongo layer treats absence as "not retired".
  if (collection === "job_logs" && (out.retired === 0 || out.retired === "0")) {
    out.retired = 0;
  }
  // Numeric columns SQLite stored as numbers already; nothing else needs coercion because
  // TEXT columns were always strings and INTEGER columns were always numbers.
  if (collection === "tg_message_cache" || collection === "tg_dialog_cache") {
    if (typeof out.msg_id === "string") out.msg_id = Number(out.msg_id);
    if (typeof out.sort_order === "string") out.sort_order = Number(out.sort_order);
  }
  return out;
}

/**
 * Copies every known table into Mongo. Existing rows are kept: ids are preserved from SQLite
 * rather than reassigned, so an import run twice must not duplicate them -- hence upsert.
 *
 * Returns per-table counts so the panel can show what arrived.
 */
export async function importFromSqlite(
  db: Db,
  sqlitePath?: string,
): Promise<ImportResult> {
  const file = sqlitePath || defaultSqlitePath();
  const result: ImportResult = { ok: true, tables: {}, skipped: [], message: "" };

  if (!fs.existsSync(file)) {
    return {
      ok: true,
      tables: {},
      skipped: [],
      message: `没有找到 SQLite 文件 (${file}), 这是一次全新安装, 无需导入.`,
    };
  }

  let Database: typeof import("better-sqlite3");
  try {
    Database = (await import("better-sqlite3")).default as any;
  } catch (e) {
    return {
      ok: false,
      tables: {},
      skipped: [],
      message: `无法加载 better-sqlite3, 不能读取旧数据: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  const sqlite = new Database(file, { readonly: true });
  try {
    // Import order matters only for readability of the counts, not for integrity: MongoDB
    // has no foreign keys to satisfy.
    for (const [table, collection, pk] of TABLES) {
      let rows: Record<string, unknown>[];
      try {
        rows = sqlite.prepare(`SELECT rowid AS rowid, * FROM ${table}`).all() as any[];
      } catch (e) {
        // A table missing from an older install is normal, not a failure.
        result.skipped.push(table);
        continue;
      }
      if (!rows.length) {
        result.tables[table] = 0;
        continue;
      }

      const ops: Array<{
        updateOne: {
          filter: Record<string, unknown>;
          update: Record<string, unknown>;
          upsert: boolean;
        };
      }> = rows.map((row) => {
        const { rowid, ...rest } = row;
        const id = pk === "rowid" ? undefined : rest[pk];
        const doc = normalise(collection, rest);
        if (pk !== "rowid") delete doc[pk];
        return {
          updateOne: {
            filter: { _id: (id ?? rowid) as unknown },
            update: { $set: doc },
            upsert: true,
          },
        };
      });

      // unordered + upsert: one bad row must not stop the other 5,000, and re-running the
      // import has to be safe.
      await db.collection(collection).bulkWrite(ops, { ordered: false });
      result.tables[table] = rows.length;

      if (pk === "id") {
        const maxId = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
        await seedCounterAbove(db, collection, maxId);
      }
    }

    await db
      .collection<{ _id: string; done: boolean }>("migrations")
      .updateOne({ _id: "sqlite-import" }, { $set: { done: true } }, { upsert: true });

    const total = Object.values(result.tables).reduce((a, b) => a + b, 0);
    result.message = `已从 SQLite 导入 ${total} 条记录.`;
    return result;
  } catch (e) {
    return {
      ok: false,
      tables: result.tables,
      skipped: result.skipped,
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    sqlite.close();
  }
}

/** True when an install has already been imported, so the panel can stop offering it. */
export async function hasImportedSqlite(db: Db): Promise<boolean> {
  const row = await db
    .collection<{ _id: string; done: boolean }>("migrations")
    .findOne({ _id: "sqlite-import" });
  return Boolean(row?.done);
}
