import { Router } from "express";

import {
  applyDbConfig,
  getDb,
  getDbState,
  initDb,
  isDbReady,
  testConnection,
} from "../db/mongo/client";
import { ensureIndexes } from "../db/mongo/schema";
import { bootstrapDatabase } from "../db/bootstrap";
import {
  DEFAULT_DB_NAME,
  clearDbConfig,
  dbNameFromUri,
  getDbConfigPath,
  loadDbConfig,
} from "../db/mongo/config";
import { hasImportedSqlite, importFromSqlite } from "../db/mongo/migrate";
import { col } from "../db/collection";
import { startScheduler } from "../scheduler";

const router = Router();

/**
 * Bemby's own database connection.
 *
 * These routes answer the question the rest of the API cannot: where the data is. They are
 * mounted before any of it, because until the connection is configured every other endpoint
 * has nothing to read or write.
 *
 * Two of them must therefore work without a session token:
 *
 *   GET  /status        -- the SPA needs to know whether to show the panel or the setup card,
 *                          and it has to ask before it has anything to authenticate with
 *   POST /test          -- checking a typed-in URI cannot depend on the URI already working
 *
 * Saving is behind requireAuth in server.ts: adopting a new database is not a read, and it is
 * reachable with the token the operator already has.
 */

/** Redacts the password in a MongoDB URI so it can be shown back in the panel. */
function maskUri(uri: string): string {
  if (!uri) return "";
  try {
    const scheme = uri.slice(0, uri.indexOf("://") + 3);
    const rest = uri.slice(scheme.length);
    const at = rest.lastIndexOf("@");
    if (at === -1) return uri;
    const credentials = rest.slice(0, at);
    const colon = credentials.indexOf(":");
    if (colon === -1) return uri;
    return `${scheme}${credentials.slice(0, colon)}:****@${rest.slice(at + 1)}`;
  } catch {
    return uri;
  }
}

async function describeState() {
  const state = getDbState();
  const base = {
    ready: state.ready,
    connecting: state.connecting,
    error: state.error,
    source: state.config.source,
    // The panel shows this instead of the plain error when nothing has been configured yet,
    // which is the state a fresh install boots into.
    configured: Boolean(state.config.uri),
    database: state.config.dbName || DEFAULT_DB_NAME,
    uriMasked: maskUri(state.config.uri),
    serverVersion: state.info?.serverVersion ?? null,
    configPath: getDbConfigPath(),
    sqliteImported: false as boolean,
    counts: null as Record<string, number> | null,
  };

  if (isDbReady()) {
    try {
      base.sqliteImported = await hasImportedSqlite(getDb());
    } catch {}
    try {
      const names = [
        "settings",
        "tg_accounts",
        "jobs",
        "job_templates",
        "job_logs",
        "ai_suppliers",
        "ai_models",
      ];
      const counts: Record<string, number> = {};
      for (const name of names) {
        counts[name] = await col(name).countDocuments({});
      }
      base.counts = counts;
    } catch {}
  }
  return base;
}

router.get("/status", async (_req, res) => {
  try {
    res.json(await describeState());
  } catch (e) {
    console.error("[database] status failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/test", async (req, res) => {
  const { uri, dbName } = req.body as { uri?: string; dbName?: string };
  if (!uri?.trim()) {
    res.status(400).json({ ok: false, message: "连接地址不能为空" });
    return;
  }
  try {
    const outcome = await testConnection(uri, dbName);
    res.json({
      ...outcome,
      database: outcome.database ?? dbName?.trim() ?? dbNameFromUri(uri) ?? DEFAULT_DB_NAME,
    });
  } catch (e) {
    res.json({ ok: false, message: e instanceof Error ? e.message : String(e) });
  }
});

router.put("/config", async (req, res) => {
  const { uri, dbName, migrate } = req.body as {
    uri?: string;
    dbName?: string;
    migrate?: boolean;
  };

  if (!uri?.trim()) {
    res.status(400).json({ ok: false, message: "连接地址不能为空" });
    return;
  }

  try {
    const outcome = await applyDbConfig(uri, dbName);
    if (!outcome.ok) {
      res.status(400).json(outcome);
      return;
    }

    // A newly adopted connection still needs its indexes, its default rows and possibly the
    // old SQLite data brought across. One sequence, because doing any of it on a later request
    // would let Bemby serve empty answers for a while and no one would know why.
    await ensureIndexes(getDb());
    await bootstrapDatabase();

    let migration = null;
    if (migrate) {
      migration = await importFromSqlite(getDb());
    }

    startSchedulerOnce();
    res.json({ ok: true, message: "已连接", migration });
  } catch (e) {
    console.error("[database] config failed:", e);
    res.status(500).json({ ok: false, message: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Imports an existing SQLite install into the current MongoDB database. Separate from saving
 * the config so it can be offered later -- an operator may want to see Bemby come up first, or
 * may have pointed at a Mongo database that already holds pasted data.
 */
router.post("/migrate-sqlite", async (_req, res) => {
  if (!isDbReady()) {
    res.status(409).json({ ok: false, message: "尚未连接数据库" });
    return;
  }
  try {
    const result = await importFromSqlite(getDb());
    res.json(result);
  } catch (e) {
    console.error("[database] sqlite import failed:", e);
    res.status(500).json({ ok: false, message: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/disconnect", async (_req, res) => {
  try {
    clearDbConfig();
    await initDb();
    res.json({ ok: true, ...(await describeState()) });
  } catch (e) {
    console.error("[database] disconnect failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

let schedulerStarted = false;

/**
 * Starts the scheduler once, the first time a database becomes usable.
 *
 * The scheduler reads jobs on its own clock, so it used to start with the process -- the SQLite
 * file was always there. Now the database may not exist yet at boot, and starting early would
 * have it read nothing forever: every request would answer fine and no job would ever run.
 */
export function startSchedulerOnce(): void {
  if (schedulerStarted || !isDbReady()) return;
  schedulerStarted = true;
  void startScheduler().catch((e) => console.error("[scheduler] start failed:", e));
}

export { describeState };
export default router;
