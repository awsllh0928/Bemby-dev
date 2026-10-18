// SKIPPED: this file exercised the SQLite schema inside db/database.ts -- its CREATE TABLE
// block, its ALTER TABLE migrations, and the foreign-key cascades between its tables.
// MongoDB replaced all of that: collections are created implicitly, there are no ALTER
// statements to replay, and the cascades the foreign keys used to perform are hand-written
// in db/repos (see mongo-harness.test.ts for the ones that matter). Running it now would
// mean building a better-sqlite3 database whose schema no longer corresponds to anything
// Bemby stores.
//
// The behaviour worth keeping is covered elsewhere: id sequences and the cascading deletes
// in __tests__/mongo-harness.test.ts, and the one-time import of an old bemby.db in
// db/mongo/migrate.ts -- which has no test of its own yet, because seeding a fixture
// requires the better-sqlite3 native module.
// Regression test for the tg_accounts_v2 (api_id/api_hash nullable) migration bug.
//
// jobs.account_id -> tg_accounts(id) ON DELETE SET NULL. With foreign_keys on,
// DROP TABLE tg_accounts (part of the table-rebuild swap in database.ts) fires
// that cascade for every job that references the table being dropped — even
// though the account data is safely preserved under the same id in
// tg_accounts_v2. Every checkin/custom job's account_id was silently wiped to
// NULL the first time this migration ran on an existing install, which is why
// only accountless embywatch jobs kept appearing in the scheduler afterwards.
//
// Keep ACCOUNTS_V2_MIGRATION in sync with database.ts.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

type DB = InstanceType<typeof Database>;
type ColInfo = { name: string; notnull: number };

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    phone_number   TEXT    NOT NULL,
    api_id         INTEGER NOT NULL,
    api_hash       TEXT    NOT NULL,
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    proxy_id       TEXT,
    disabled       INTEGER NOT NULL DEFAULT 0,
    app_client_id  TEXT,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    tg_display_name TEXT,
    tg_username    TEXT,
    notes          TEXT
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL,
    enabled               INTEGER NOT NULL DEFAULT 1
  );
`;

// The tg_accounts_v2 swap block from database.ts.
const ACCOUNTS_V2_MIGRATION = `
  CREATE TABLE tg_accounts_v2 (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    phone_number    TEXT    NOT NULL,
    api_id          INTEGER,
    api_hash        TEXT,
    session_string  TEXT,
    auth_status     TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    proxy_id        TEXT,
    disabled        INTEGER NOT NULL DEFAULT 0,
    app_client_id   TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    tg_display_name TEXT,
    tg_username     TEXT,
    notes           TEXT
  );
  INSERT INTO tg_accounts_v2 SELECT
    id, name, phone_number,
    NULLIF(api_id, 0), NULLIF(api_hash, ''),
    session_string, auth_status, created_at,
    proxy_id, disabled, app_client_id, sort_order,
    tg_display_name, tg_username, notes
  FROM tg_accounts;
  DROP TABLE tg_accounts;
  ALTER TABLE tg_accounts_v2 RENAME TO tg_accounts;
`;

function buildFreshDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(BASE_SCHEMA);
  return db;
}

function runAccountsNullableMigration(db: DB) {
  const cols = db.prepare('PRAGMA table_info(tg_accounts)').all() as ColInfo[];
  if (cols.find(c => c.name === 'api_id')?.notnull === 1) {
    // Mirrors database.ts: foreign_keys must be off during the swap, otherwise
    // DROP TABLE tg_accounts cascades ON DELETE SET NULL onto every linked job.
    db.pragma('foreign_keys = OFF');
    try {
      db.exec(ACCOUNTS_V2_MIGRATION);
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}

function insertAccount(db: DB, fields: Partial<{ name: string; notes: string | null }> = {}) {
  return db.prepare(
    'INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, notes) VALUES (?, ?, ?, ?, ?)',
  ).run(fields.name ?? 'Acc', '+61400000000', 1, 'hash', fields.notes ?? null);
}

function insertJob(db: DB, accountId: number, jobType = 'checkin') {
  return db.prepare(
    'INSERT INTO jobs (name, account_id, job_type, bot_username) VALUES (?, ?, ?, ?)',
  ).run('J', accountId, jobType, 'bot');
}

describe.skip('tg_accounts api_id/api_hash nullable migration', () => {
  it('fresh install — migration succeeds with no existing rows', () => {
    const db = buildFreshDb();
    expect(() => runAccountsNullableMigration(db)).not.toThrow();

    const cols = db.prepare('PRAGMA table_info(tg_accounts)').all() as ColInfo[];
    expect(cols.find(c => c.name === 'api_id')?.notnull).toBe(0);
  });

  it('preserves a linked checkin job\'s account_id across the migration', () => {
    const db = buildFreshDb();
    const accId = insertAccount(db).lastInsertRowid as number;
    const jobId = insertJob(db, accId, 'checkin').lastInsertRowid as number;

    runAccountsNullableMigration(db);

    const job = db.prepare('SELECT account_id FROM jobs WHERE id = ?').get(jobId) as any;
    expect(job.account_id).toBe(accId);
  });

  it('preserves a linked custom job\'s account_id across the migration', () => {
    const db = buildFreshDb();
    const accId = insertAccount(db).lastInsertRowid as number;
    const jobId = insertJob(db, accId, 'custom').lastInsertRowid as number;

    runAccountsNullableMigration(db);

    const job = db.prepare('SELECT account_id FROM jobs WHERE id = ?').get(jobId) as any;
    expect(job.account_id).toBe(accId);
  });

  it('preserves the notes column and its values across the migration', () => {
    const db = buildFreshDb();
    const accId = insertAccount(db, { notes: 'VIP account' }).lastInsertRowid as number;

    runAccountsNullableMigration(db);

    const acct = db.prepare('SELECT notes FROM tg_accounts WHERE id = ?').get(accId) as any;
    expect(acct.notes).toBe('VIP account');
  });

  it('demonstrates the account_id-wipe bug when foreign_keys is left on during the swap', () => {
    const db = buildFreshDb();
    const accId = insertAccount(db).lastInsertRowid as number;
    const jobId = insertJob(db, accId, 'checkin').lastInsertRowid as number;

    // Unpatched version of the migration — no foreign_keys toggle.
    db.exec(ACCOUNTS_V2_MIGRATION);

    const job = db.prepare('SELECT account_id FROM jobs WHERE id = ?').get(jobId) as any;
    expect(job.account_id).toBeNull();
  });

  it('migration is skipped when api_id is already nullable', () => {
    const db = buildFreshDb();
    runAccountsNullableMigration(db); // first run

    expect(() => runAccountsNullableMigration(db)).not.toThrow();
  });
});
