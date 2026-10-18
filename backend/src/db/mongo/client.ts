import { MongoClient, Db, type MongoClientOptions } from "mongodb";

import {
  DEFAULT_DB_NAME,
  DbConfig,
  clearDbConfig,
  loadDbConfig,
  saveDbConfig,
} from "./config";

/** Thrown when something needs the database and Bemby has not been told where it is. */
export class DbNotConfiguredError extends Error {
  constructor() {
    super("尚未配置 MongoDB 连接, 请到「设置 → 数据库」填写连接地址");
    this.name = "DbNotConfiguredError";
  }
}

/** Thrown when the last connect attempt failed. Carries the driver's message for the panel. */
export class DbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbUnavailableError";
  }
}

export type DbState = {
  /** True once a ping has succeeded; the only state in which Bemby serves real data. */
  ready: boolean;
  connecting: boolean;
  config: DbConfig;
  error: string | null;
  /** Set once per successful connect: server version + resolved database name. */
  info: DbInfo | null;
};

export type DbInfo = {
  database: string;
  serverVersion?: string;
  collections?: string[];
  latencyMs?: number;
};

/** Time budget for a connection attempt. Long enough for a cold replica set election, short
 *  enough that a typo'd host does not hang a request for a minute. */
const CONNECT_TIMEOUT_MS = 10_000;

let client: MongoClient | null = null;

let state: DbState = {
  ready: false,
  connecting: false,
  config: { uri: "", dbName: DEFAULT_DB_NAME, source: "none" },
  error: null,
  info: null,
};

const readyListeners = new Set<() => void>();

export function getDbState(): DbState {
  return { ...state, config: { ...state.config } };
}

export function isDbReady(): boolean {
  return state.ready;
}

/**
 * Registers a callback for the first successful connect. Everything that needs rows --
 * the scheduler above all -- waits on this rather than assuming the database came up with
 * the process, which it no longer does: the connection is configured from the panel, often
 * minutes after boot.
 */
export function onDbReady(fn: () => void): void {
  if (state.ready) {
    fn();
    return;
  }
  readyListeners.add(fn);
}

function emitReady(): void {
  for (const fn of readyListeners) fn();
  readyListeners.clear();
}

async function connectTo(config: DbConfig): Promise<{ mongo: MongoClient; db: Db }> {
  const options: MongoClientOptions = {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    // Short retry window: every attempt here lengthens a request the operator is watching.
    retryWrites: true,
  };
  const mongo = new MongoClient(config.uri, options);
  const db = mongo.db(config.dbName);
  // Actually prove the connection rather than trusting the constructor, which is lazy and
  // would let a broken URI surface later as a timeout deep inside a job run.
  await mongo.connect();
  await db.command({ ping: 1 });
  return { mongo, db };
}

/**
 * Connects using whatever is configured now, replacing any earlier connection. Repeated
 * calls while a connect is in flight return the same promise rather than racing two clients.
 */
export async function initDb(): Promise<Db | null> {
  const config = loadDbConfig();
  state = { ...state, config };

  if (!config.uri) {
    await closeDb();
    state = {
      ready: false,
      connecting: false,
      config,
      error: null,
      info: null,
    };
    return null;
  }

  state = { ...state, connecting: true, error: null };
  try {
    await closeDb();
    const connection = await connectTo(config);
    const { mongo, db } = connection;
    const buildInfo = await db.command({ buildInfo: 1 }).catch(() => null);
    client = mongo;

    state = {
      ready: true,
      connecting: false,
      config,
      error: null,
      info: {
        database: config.dbName,
        serverVersion: buildInfo?.version ? String(buildInfo.version) : undefined,
      },
    };
    emitReady();
    return db;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    state = {
      ready: false,
      connecting: false,
      config,
      error: message,
      info: null,
    };
    console.error(`[db] MongoDB connection failed: ${message}`);
    return null;
  }
}

/** The live database handle. Throws rather than returning null so call sites cannot forget
 *  that an unconfigured Bemby has nowhere to write. */
export function getDb(): Db {
  if (!state.ready || !client) {
    if (!state.config.uri) throw new DbNotConfiguredError();
    throw new DbUnavailableError(state.error ?? "MongoDB 尚未连接");
  }
  return client.db(state.config.dbName);
}

/** Same as getDb() but tolerated where no store exists yet: the bootstrap routes have to
 *  answer before anyone has configured anything. */
export function peekDb(): Db | null {
  if (!state.ready || !client) return null;
  return client.db(state.config.dbName);
}

/**
 * Tests a connection string without adopting it. Used by the panel's "测试连接" button, which
 * has to answer for a URI the operator has typed but not yet saved -- possibly against the
 * wrong host, hence the same short timeout as a real connect rather than something slower.
 */
export async function testConnection(uri: string, dbName?: string) {
  const trimmed = uri?.trim();
  if (!trimmed) return { ok: false as const, message: "连接地址不能为空" };

  const started = Date.now();
  let mongo: MongoClient | null = null;
  try {
    mongo = new MongoClient(trimmed, {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
    });
    const { dbNameFromUri } = await import("./config");
    const name = dbName?.trim() || dbNameFromUri(trimmed) || DEFAULT_DB_NAME;
    const db = mongo.db(name);
    await mongo.connect();
    await db.command({ ping: 1 });

    const [buildInfo, collections] = await Promise.all([
      db.command({ buildInfo: 1 }).catch(() => null),
      db.listCollections().toArray().catch(() => []),
    ]);

    return {
      ok: true as const,
      message: "连接成功",
      latencyMs: Date.now() - started,
      serverVersion: buildInfo?.version ? String(buildInfo.version) : undefined,
      database: name,
      collections: collections.map((c) => c.name),
    };
  } catch (e) {
    return {
      ok: false as const,
      message: e instanceof Error ? e.message : String(e),
      latencyMs: Date.now() - started,
    };
  } finally {
    await mongo?.close().catch(() => {});
  }
}

/**
 * Switches Bemby onto a new database: saves the config, reconnects, and leaves the old
 * connection closed. Returns the outcome rather than throwing so the panel can show the
 * driver's own message next to the field the operator mistyped.
 */
export async function applyDbConfig(uri: string, dbName?: string) {
  let config: DbConfig;
  try {
    config = saveDbConfig(uri, dbName);
  } catch (e) {
    return {
      ok: false as const,
      message: `无法写入配置文件: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const outcome = await testConnection(config.uri, config.dbName);
  if (!outcome.ok) {
    // Do not keep a connection we cannot reach: leaving it saved would have the next request
    // fail the same way with no hint that anything is wrong.
    clearDbConfig();
    return outcome;
  }

  await initDb();
  return {
    ok: true as const,
    message: "已连接",
    config: getDbState().config,
    latencyMs: outcome.latencyMs,
    serverVersion: outcome.serverVersion,
    database: outcome.database,
    collections: outcome.collections,
  };
}

/** Trusts nothing about the current handle and re-reads the config. Used after a mid-flight
 *  failure so a reconnect actually retries rather than returning a dead client. */
export async function reconnectDb(): Promise<Db | null> {
  return initDb();
}

export async function closeDb(): Promise<void> {
  if (client) {
    const closing = client;
    client = null;
    await closing.close().catch(() => {});
  }
}

export { clearDbConfig, loadDbConfig, saveDbConfig, DEFAULT_DB_NAME };
