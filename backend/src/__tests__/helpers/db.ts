import type { Document, OptionalUnlessRequiredId, WithId } from "mongodb";
import { afterAll, beforeAll, beforeEach } from "vitest";

import { closeDb, getDb, initDb } from "../../db/mongo/client";
import { COLLECTIONS, ensureIndexes } from "../../db/mongo/schema";
import { seedCounterAbove } from "../../db/mongo/ids";
import { bootstrapDatabase } from "../../db/bootstrap";
import type {
  AccountDoc,
  AiModelDoc,
  AiSupplierDoc,
  JobDoc,
  JobLogDoc,
  JobTemplateDoc,
} from "../../db/types";

/**
 * Minimal row factories.
 *
 * The old suite created its tables with six columns and inserted three of them. Mongo has no
 * `DEFAULT ''` to fall back on, so a test that only cares about a job's schedule would
 * otherwise have to spell out `bot_username`, `timezone`, `retry_max` and the rest. These
 * supply the boring fields; anything a test actually asserts on it passes in itself.
 *
 * `_id` is left to the caller on purpose: most tests want to know which id they got, and
 * hard-coding it is the only way to refer to it afterwards.
 */
export function jobDoc(overrides: Partial<JobDoc> = {}): JobDoc {
  return {
    _id: 1,
    name: "Job",
    account_id: null,
    job_type: "checkin",
    bot_username: "bot",
    schedule_window_start: 0,
    schedule_window_end: 1439,
    timezone: "UTC",
    reply_timeout_ms: 60_000,
    retry_max: 3,
    enabled: 1,
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function accountDoc(overrides: Partial<AccountDoc> = {}): AccountDoc {
  return {
    _id: 1,
    name: "Account",
    phone_number: "+10000000000",
    api_id: null,
    api_hash: null,
    session_string: null,
    auth_status: "ready",
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function templateDoc(overrides: Partial<JobTemplateDoc> = {}): JobTemplateDoc {
  return {
    _id: 1,
    name: "Template",
    job_type: "checkin",
    bot_username: "bot",
    timezone: "UTC",
    reply_timeout_ms: 60_000,
    retry_max: 3,
    enabled: 1,
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function logDoc(overrides: Partial<JobLogDoc> = {}): JobLogDoc {
  return {
    _id: 1,
    job_id: 1,
    ran_at: "2024-01-01T00:00:00.000Z",
    status: "success",
    ...overrides,
  };
}

export function supplierDoc(overrides: Partial<AiSupplierDoc> = {}): AiSupplierDoc {
  return {
    _id: 1,
    name: "Supplier",
    base_url: "https://api.example.com/v1",
    api_key: "sk-test",
    timeout_ms: 30_000,
    ...overrides,
  };
}

export function aiModelDoc(overrides: Partial<AiModelDoc> = {}): AiModelDoc {
  return { _id: 1, supplier_id: 1, model_id: "gpt-4o-mini", ...overrides };
}

/**
 * What a test file needs in order to touch rows.
 *
 * The SQLite suite built its store by running `CREATE TABLE` against a fresh file, which took
 * microseconds and could happen inside any `beforeAll`. Here the store already exists -- the
 * server started in globalSetup -- so the per-file work is connecting to it and emptying it.
 *
 * `initTestDb` is idempotent and remembers that it ran, so a file can call it from several
 * hooks without opening a connection each time.
 */

let started = false;

/** Connects and creates the indexes. Cheap to call more than once. */
export async function initTestDb(): Promise<void> {
  if (started) return;
  const db = await initDb();
  if (!db) {
    throw new Error(
      `测试数据库未就绪: MONGODB_URI=${process.env.MONGODB_URI ?? "(空)"}`,
    );
  }
  await ensureIndexes(db);
  started = true;
}

/**
 * Empties every collection, including the id counters.
 *
 * The counters matter: ids are handed out from a document in the database, not from a table's
 * own rowid, so skipping them would let a later test in the same file continue the numbering
 * of an earlier one.
 */
export async function resetDb(): Promise<void> {
  await initTestDb();
  const db = getDb();
  await Promise.all(COLLECTIONS.map((name) => db.collection(name).deleteMany({})));
}

/**
 * Runs the real boot sequence: shipped default settings, the Telegram app-client presets,
 * the one-off data fix-ups.
 */
export async function bootstrapTestDb(): Promise<void> {
  await initTestDb();
  await bootstrapDatabase();
}

/** Inserts rows straight into a collection, bypassing the repositories. */
export async function insert<T extends Document = Document>(
  collection: (typeof COLLECTIONS)[number] | string,
  docs: OptionalUnlessRequiredId<T>[],
): Promise<void> {
  await initTestDb();
  if (!docs.length) return;
  await getDb().collection(collection).insertMany(docs as Document[]);
}

/** Empties one collection. For a file that re-seeds the same rows partway through a test. */
export async function clear(
  collection: (typeof COLLECTIONS)[number] | string,
): Promise<void> {
  await initTestDb();
  await getDb().collection(collection).deleteMany({});
}

/**
 * Reads a whole collection back -- the convenient way to assert on what got written.
 *
 * `WithId<T>` rather than `T`: the driver adds `_id` to whatever it returns, and a document
 * type that omits it would otherwise make every read look like a mistake.
 */
export async function dump<T extends Document = Document>(
  collection: (typeof COLLECTIONS)[number] | string,
): Promise<WithId<T>[]> {
  await initTestDb();
  return getDb().collection<T>(collection).find({}).toArray();
}

/**
 * Moves a collection's id counter past `maxId`.
 *
 * Tests insert rows with an explicit `_id` so they can name them afterwards, and the counter
 * that hands out ids knows nothing about them. A route that then creates a row through a
 * repository would be given an id that is already taken and fail with a duplicate key.
 */
export async function syncCounter(collection: string, maxId: number): Promise<void> {
  await initTestDb();
  await seedCounterAbove(getDb(), collection, maxId);
}

/**
 * Closes the connection and drops the database this file used.
 *
 * Dropping matters now that every test file gets its own: 60-odd databases of job logs are
 * left behind otherwise, and the server is running in memory.
 */
export async function stopTestDb(): Promise<void> {
  if (started) {
    try {
      await getDb().dropDatabase();
    } catch {
      /* the connection may already be gone; nothing to clean up */
    }
  }
  started = false;
  await closeDb();
}

/**
 * Registers the usual hooks for a file that uses rows.
 *
 * Every test starts from an empty database, so no test inherits the previous one's rows. With
 * `bootstrap: true` the shipped defaults are re-seeded after each wipe, which is what a test
 * asserting on default settings wants.
 */
export function useTestDb(options: { bootstrap?: boolean } = {}): void {
  beforeAll(async () => {
    await initTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    if (options.bootstrap) await bootstrapDatabase();
  });

  afterAll(async () => {
    await stopTestDb();
  });
}
