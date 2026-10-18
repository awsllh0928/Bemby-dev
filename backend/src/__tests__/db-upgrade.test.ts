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
// Tests that app upgrades (migrations) do not clear or overwrite existing user data.
// All tests use an in-memory SQLite database to replay the exact migration SQL from database.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

type DB = InstanceType<typeof Database>;

// Minimal schema representing the very first release of the app
const INITIAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    phone_number   TEXT    NOT NULL,
    api_id         INTEGER NOT NULL,
    api_hash       TEXT    NOT NULL,
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS job_templates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    bot_username     TEXT    NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    account_id            INTEGER NOT NULL REFERENCES tg_accounts(id) ON DELETE CASCADE,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL DEFAULT '',
    schedule_window_start INTEGER NOT NULL DEFAULT 1400,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
    timezone              TEXT    NOT NULL DEFAULT 'Australia/Sydney',
    reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
    retry_max             INTEGER NOT NULL DEFAULT 5,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_suppliers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    base_url   TEXT    NOT NULL,
    api_key    TEXT    NOT NULL DEFAULT '',
    timeout_ms INTEGER NOT NULL DEFAULT 25000
  );
  CREATE TABLE IF NOT EXISTS ai_models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES ai_suppliers(id) ON DELETE CASCADE,
    model_id    TEXT    NOT NULL,
    label       TEXT
  );
`;

function getSetting(db: DB, key: string): string | null {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

function seedDefaultSettings(db: DB) {
  db.exec(`
    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('default_timezone',     'Australia/Sydney'),
      ('default_max_retry',    '5'),
      ('check_daily_run',      'true'),
      ('default_ua',           'SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0'),
      ('default_play_duration','300'),
      ('default_device_name',  'Mac'),
      ('ai_base_url',          'https://openrouter.ai/api/v1'),
      ('ai_api_key',           ''),
      ('ai_model',             'nvidia/nemotron-nano-12b-v2-vl:free'),
      ('ai_timeout_ms',        '25000')
  `);
}

// ── Seeding with INSERT OR IGNORE ────────────────────────────────────────────

describe.skip('db upgrade -- INSERT OR IGNORE does not overwrite user settings', () => {
  let db: DB;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(INITIAL_SCHEMA);
    seedDefaultSettings(db);
  });

  it('user-modified timezone survives a re-seed', () => {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('America/New_York', 'default_timezone');
    // Simulate upgrade re-running the seed
    db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('default_timezone', 'Australia/Sydney')");
    expect(getSetting(db, 'default_timezone')).toBe('America/New_York');
  });

  it('user-customised ua_presets survive re-seed', () => {
    const custom = JSON.stringify([{ name: 'My App', value: 'MyApp/1.0' }]);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ua_presets', custom);
    db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('ua_presets', 'overwrite-attempt')");
    expect(getSetting(db, 'ua_presets')).toBe(custom);
  });

  it('user-customised tg_app_clients survive re-seed', () => {
    const custom = JSON.stringify([{ id: 'my-profile', name: 'My Device', isDefault: true }]);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('tg_app_clients', custom);
    db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('tg_app_clients', 'overwrite-attempt')");
    expect(getSetting(db, 'tg_app_clients')).toBe(custom);
  });

  it('extra user-created settings survive all default seeds', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('my_private_setting', 'my_value');
    seedDefaultSettings(db);
    expect(getSetting(db, 'my_private_setting')).toBe('my_value');
  });
});

// ── Conditional UPDATE migrations ────────────────────────────────────────────

describe.skip('db upgrade -- conditional UPDATE migrations leave custom values alone', () => {
  let db: DB;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(INITIAL_SCHEMA);
    seedDefaultSettings(db);
  });

  it('device name migration only touches the old stale value, not a custom one', () => {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('My Custom Device', 'default_device_name');
    // These are the two conditional migrations from database.ts
    db.exec("UPDATE settings SET value = 'Yamby' WHERE key = 'default_device_name' AND value = 'tg-runner'");
    db.exec("UPDATE settings SET value = 'Mac' WHERE key = 'default_device_name' AND value = 'Yamby'");
    expect(getSetting(db, 'default_device_name')).toBe('My Custom Device');
  });

  it('ua migration only touches the old Chrome/Windows placeholder, not a custom UA', () => {
    const customUa = 'MyClient/3.0 custom-string';
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(customUa, 'default_ua');
    db.exec("UPDATE settings SET value = 'SenPlayer/6.1.0 CFNetwork/1490.0.4 Darwin/23.2.0' WHERE key = 'default_ua' AND value = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'");
    expect(getSetting(db, 'default_ua')).toBe(customUa);
  });

  it('stale ua_presets with ExoPlayerLib placeholder get updated to the correct values', () => {
    const stale = '[{"name":"SenPlayer (Mac)","value":"ExoPlayerLib/1.0"}]';
    const expected = '[{"name":"SenPlayer (Mac)","value":"SenPlayer/6.1.2"}]';
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ua_presets', stale);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'ua_presets' AND (value LIKE '%ExoPlayerLib%' OR value LIKE '%VidHub/2.1.0%')").run(expected);
    expect(getSetting(db, 'ua_presets')).toBe(expected);
  });

  it('current ua_presets with a user value are not touched by the stale-preset migration', () => {
    const custom = '[{"name":"My Preset","value":"MyApp/2.0"}]';
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ua_presets', custom);
    const replacement = '[{"name":"Updated","value":"SenPlayer/6.1.2"}]';
    db.prepare("UPDATE settings SET value = ? WHERE key = 'ua_presets' AND (value LIKE '%ExoPlayerLib%' OR value LIKE '%VidHub/2.1.0%')").run(replacement);
    expect(getSetting(db, 'ua_presets')).toBe(custom);
  });
});

// ── ALTER TABLE migrations are idempotent ────────────────────────────────────

describe.skip('db upgrade -- ALTER TABLE ADD COLUMN migrations are idempotent', () => {
  let db: DB;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(INITIAL_SCHEMA);
  });

  function runAccountMigrations(db: DB) {
    try { db.exec('ALTER TABLE tg_accounts ADD COLUMN proxy_id TEXT'); } catch {}
    try { db.exec('ALTER TABLE tg_accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0'); } catch {}
    try { db.exec('ALTER TABLE tg_accounts ADD COLUMN app_client_id TEXT'); } catch {}
    try { db.exec('ALTER TABLE tg_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0'); } catch {}
    try { db.exec('ALTER TABLE tg_accounts ADD COLUMN tg_display_name TEXT'); } catch {}
    try { db.exec('ALTER TABLE tg_accounts ADD COLUMN tg_username TEXT'); } catch {}
  }

  it('running all tg_accounts ALTER migrations twice does not throw', () => {
    expect(() => runAccountMigrations(db)).not.toThrow();
    expect(() => runAccountMigrations(db)).not.toThrow();
  });

  it('existing account data survives all ALTER TABLE ADD COLUMN migrations', () => {
    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status) VALUES (?, ?, ?, ?, ?, ?)')
      .run('Alice', '+61400000001', 12345, 'secrethash', 'my-session', 'authenticated');

    runAccountMigrations(db);

    const row = db.prepare('SELECT * FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    expect(row.name).toBe('Alice');
    expect(row.api_hash).toBe('secrethash');
    expect(row.session_string).toBe('my-session');
    expect(row.auth_status).toBe('authenticated');
    // New columns get their defaults
    expect(row.disabled).toBe(0);
    expect(row.proxy_id).toBeNull();
  });

  it('job_logs ALTER migrations are idempotent', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_logs (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        ran_at TEXT    NOT NULL,
        status TEXT    NOT NULL
      )
    `);
    const runLogMigrations = () => {
      try { db.exec("ALTER TABLE job_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'scheduler'"); } catch {}
      try { db.exec('ALTER TABLE job_logs ADD COLUMN detail TEXT'); } catch {}
      try { db.exec('ALTER TABLE job_logs ADD COLUMN retired INTEGER NOT NULL DEFAULT 0'); } catch {}
    };
    expect(() => runLogMigrations()).not.toThrow();
    expect(() => runLogMigrations()).not.toThrow();
  });
});

// ── sort_order migration ──────────────────────────────────────────────────────

describe.skip('db upgrade -- sort_order migration preserves user-defined order', () => {
  let db: DB;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(INITIAL_SCHEMA);
    try { db.exec('ALTER TABLE tg_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0'); } catch {}
    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Alice', '+61400000001', 1, 'h1');
    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Bob', '+61400000002', 1, 'h2');
    db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Carol', '+61400000003', 1, 'h3');
  });

  it('first migration seeds sort_order from id for zero-valued rows', () => {
    db.exec('UPDATE tg_accounts SET sort_order = id WHERE sort_order = 0');
    const rows = db.prepare('SELECT id, sort_order FROM tg_accounts ORDER BY id').all() as any[];
    for (const r of rows) expect(r.sort_order).toBe(r.id);
  });

  it('second migration run is a no-op after user has reordered accounts', () => {
    // First migration
    db.exec('UPDATE tg_accounts SET sort_order = id WHERE sort_order = 0');
    // User reorders: Carol first, Alice second, Bob third
    db.prepare('UPDATE tg_accounts SET sort_order = 1 WHERE phone_number = ?').run('+61400000003');
    db.prepare('UPDATE tg_accounts SET sort_order = 2 WHERE phone_number = ?').run('+61400000001');
    db.prepare('UPDATE tg_accounts SET sort_order = 3 WHERE phone_number = ?').run('+61400000002');

    // Simulated second app start
    db.exec('UPDATE tg_accounts SET sort_order = id WHERE sort_order = 0');

    const carol = db.prepare('SELECT sort_order FROM tg_accounts WHERE phone_number = ?').get('+61400000003') as any;
    const alice = db.prepare('SELECT sort_order FROM tg_accounts WHERE phone_number = ?').get('+61400000001') as any;
    const bob   = db.prepare('SELECT sort_order FROM tg_accounts WHERE phone_number = ?').get('+61400000002') as any;
    expect(carol.sort_order).toBe(1);
    expect(alice.sort_order).toBe(2);
    expect(bob.sort_order).toBe(3);
  });
});

// ── AI supplier seeding ───────────────────────────────────────────────────────

describe.skip('db upgrade -- AI supplier seeding skips existing suppliers', () => {
  let db: DB;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(INITIAL_SCHEMA);
    seedDefaultSettings(db);
  });

  function runAiSupplierSeed(db: DB) {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM ai_suppliers').get() as { n: number }).n;
    if (count === 0) {
      const apiKey = getSetting(db, 'ai_api_key') ?? '';
      const baseUrl = getSetting(db, 'ai_base_url') ?? 'https://openrouter.ai/api/v1';
      const model = getSetting(db, 'ai_model') ?? 'nvidia/nemotron-nano-12b-v2-vl:free';
      const timeout = Number(getSetting(db, 'ai_timeout_ms')) || 25000;
      const { lastInsertRowid } = db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)')
        .run('OpenRouter', baseUrl, apiKey, timeout);
      db.prepare('INSERT INTO ai_models (supplier_id, model_id) VALUES (?, ?)').run(lastInsertRowid, model);
    }
  }

  it('seeds a default supplier on a fresh install', () => {
    runAiSupplierSeed(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_suppliers').get() as any).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_models').get() as any).n).toBe(1);
  });

  it('does not add a second supplier when one already exists (upgrade path)', () => {
    db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run('My Supplier', 'https://my.api/v1', 'sk-mine', 30000);
    runAiSupplierSeed(db);
    const suppliers = db.prepare('SELECT * FROM ai_suppliers').all() as any[];
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0].name).toBe('My Supplier');
    expect(suppliers[0].api_key).toBe('sk-mine');
  });

  it('carries legacy ai_api_key setting into the seeded supplier', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ai_api_key', 'legacy-key-abc');
    runAiSupplierSeed(db);
    const supplier = db.prepare('SELECT * FROM ai_suppliers').get() as any;
    expect(supplier.api_key).toBe('legacy-key-abc');
  });

  it('carries legacy ai_base_url setting into the seeded supplier', () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ai_base_url', 'https://custom.llm/v2');
    runAiSupplierSeed(db);
    const supplier = db.prepare('SELECT * FROM ai_suppliers').get() as any;
    expect(supplier.base_url).toBe('https://custom.llm/v2');
  });
});

// ── jobs.last_success_at backfill ─────────────────────────────────────────────

describe.skip('db upgrade -- jobs.last_success_at backfill', () => {
  let db: DB;

  // Mirrors runOnce() in database.ts
  function runOnce(id: string, fn: () => void) {
    const flagKey = `migration:${id}`;
    if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(flagKey)) return;
    fn();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(flagKey);
  }

  function runBackfill() {
    try { db.exec('ALTER TABLE jobs ADD COLUMN last_success_at TEXT'); } catch {}
    runOnce('jobs-last-success-at-backfill', () => {
      db.exec(`
        UPDATE jobs SET last_success_at = (
          SELECT MAX(l.ran_at) FROM job_logs l
          WHERE l.job_id = jobs.id AND l.status = 'success'
        )
        WHERE last_success_at IS NULL
      `);
    });
  }

  function lastSuccess(jobId: number): string | null {
    return (db.prepare('SELECT last_success_at FROM jobs WHERE id = ?').get(jobId) as any).last_success_at;
  }

  function addJob(name: string): number {
    return db.prepare('INSERT INTO jobs (name, account_id, bot_username) VALUES (?, ?, ?)')
      .run(name, null, '@bot').lastInsertRowid as number;
  }

  function addLog(jobId: number, ranAt: string, status: string) {
    db.prepare('INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, ?)').run(jobId, ranAt, status);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(INITIAL_SCHEMA);
    // account_id is nullable in the post-rebuild schema this column ships against
    db.exec('DROP TABLE jobs');
    db.exec(`
      CREATE TABLE jobs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        account_id   INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
        bot_username TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE job_logs (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        ran_at TEXT    NOT NULL,
        status TEXT    NOT NULL
      );
    `);
  });

  it('backfills the most recent successful run from surviving log history', () => {
    const id = addJob('Job A');
    addLog(id, '2026-01-01T10:00:00Z', 'success');
    addLog(id, '2026-03-05T10:00:00Z', 'success');
    addLog(id, '2026-02-01T10:00:00Z', 'success');

    runBackfill();

    expect(lastSuccess(id)).toBe('2026-03-05T10:00:00Z');
  });

  it('ignores failed and running rows', () => {
    const id = addJob('Job B');
    addLog(id, '2026-01-01T10:00:00Z', 'success');
    addLog(id, '2026-04-01T10:00:00Z', 'failed');
    addLog(id, '2026-05-01T10:00:00Z', 'running');

    runBackfill();

    expect(lastSuccess(id)).toBe('2026-01-01T10:00:00Z');
  });

  it('leaves jobs with no successful history as null', () => {
    const id = addJob('Job C');
    addLog(id, '2026-01-01T10:00:00Z', 'failed');

    runBackfill();

    expect(lastSuccess(id)).toBeNull();
  });

  it('does not cross-contaminate jobs', () => {
    const a = addJob('Job A');
    const b = addJob('Job B');
    addLog(a, '2026-01-01T10:00:00Z', 'success');
    addLog(b, '2026-06-01T10:00:00Z', 'success');

    runBackfill();

    expect(lastSuccess(a)).toBe('2026-01-01T10:00:00Z');
    expect(lastSuccess(b)).toBe('2026-06-01T10:00:00Z');
  });

  it('second boot does not re-run the backfill after logs are purged', () => {
    const id = addJob('Job D');
    addLog(id, '2026-01-01T10:00:00Z', 'success');

    runBackfill();
    expect(lastSuccess(id)).toBe('2026-01-01T10:00:00Z');

    // Retention purge wipes the history, then the app restarts
    db.exec('DELETE FROM job_logs');
    runBackfill();

    expect(lastSuccess(id)).toBe('2026-01-01T10:00:00Z');
  });

  it('a live value recorded by a run is never overwritten by the backfill', () => {
    const id = addJob('Job E');
    db.exec('ALTER TABLE jobs ADD COLUMN last_success_at TEXT');
    db.prepare('UPDATE jobs SET last_success_at = ? WHERE id = ?').run('2026-07-20T08:00:00Z', id);
    // Stale log history that predates the recorded value
    addLog(id, '2026-01-01T10:00:00Z', 'success');

    runBackfill();

    expect(lastSuccess(id)).toBe('2026-07-20T08:00:00Z');
  });

  it('existing job data survives the ALTER', () => {
    const id = addJob('Job F');
    runBackfill();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;
    expect(row.name).toBe('Job F');
    expect(row.bot_username).toBe('@bot');
  });
});

// ── recording a successful run ────────────────────────────────────────────────

describe.skip('db upgrade -- last_success_at only moves forward', () => {
  let db: DB;

  const RECORD_SQL = `UPDATE jobs SET last_success_at = ?
     WHERE id = ? AND (last_success_at IS NULL OR last_success_at < ?)`;

  function record(jobId: number, ranAt: string) {
    db.prepare(RECORD_SQL).run(ranAt, jobId, ranAt);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE jobs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        last_success_at TEXT
      );
    `);
    db.prepare('INSERT INTO jobs (name) VALUES (?)').run('J');
  });

  it('sets the value on the first successful run', () => {
    record(1, '2026-07-01T00:00:00Z');
    expect((db.prepare('SELECT last_success_at FROM jobs WHERE id = 1').get() as any).last_success_at)
      .toBe('2026-07-01T00:00:00Z');
  });

  it('advances to a later run', () => {
    record(1, '2026-07-01T00:00:00Z');
    record(1, '2026-07-05T00:00:00Z');
    expect((db.prepare('SELECT last_success_at FROM jobs WHERE id = 1').get() as any).last_success_at)
      .toBe('2026-07-05T00:00:00Z');
  });

  it('a slow run finishing out of order does not rewind the value', () => {
    record(1, '2026-07-05T00:00:00Z');
    record(1, '2026-07-01T00:00:00Z'); // started earlier, finished later
    expect((db.prepare('SELECT last_success_at FROM jobs WHERE id = 1').get() as any).last_success_at)
      .toBe('2026-07-05T00:00:00Z');
  });
});

// ── jobs account_id nullable migration (data preservation) ───────────────────

describe.skip('db upgrade -- jobs_v2 migration preserves all job data', () => {
  let db: DB;

  const JOBS_V2_MIGRATION = `
    DROP TABLE IF EXISTS jobs_v2;
    CREATE TABLE jobs_v2 (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      name                  TEXT    NOT NULL,
      account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
      job_type              TEXT    NOT NULL DEFAULT 'checkin',
      bot_username          TEXT    NOT NULL DEFAULT '',
      schedule_window_start INTEGER NOT NULL DEFAULT 1400,
      schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
      timezone              TEXT    NOT NULL DEFAULT 'Australia/Sydney',
      reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
      retry_max             INTEGER NOT NULL DEFAULT 5,
      enabled               INTEGER NOT NULL DEFAULT 1,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      config                TEXT,
      start_command         TEXT    NOT NULL DEFAULT '/start',
      checkin_button        TEXT    NOT NULL DEFAULT '签到',
      template_id           INTEGER REFERENCES job_templates(id) ON DELETE SET NULL,
      run_every_days        INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO jobs_v2 SELECT * FROM jobs;
    DROP TABLE jobs;
    ALTER TABLE jobs_v2 RENAME TO jobs;
  `;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(INITIAL_SCHEMA);
    // Apply the column additions that would exist before the jobs_v2 migration
    try { db.exec('ALTER TABLE jobs ADD COLUMN config TEXT'); } catch {}
    try { db.exec("ALTER TABLE jobs ADD COLUMN start_command TEXT NOT NULL DEFAULT '/start'"); } catch {}
    try { db.exec("ALTER TABLE jobs ADD COLUMN checkin_button TEXT NOT NULL DEFAULT '签到'"); } catch {}
    try { db.exec('ALTER TABLE jobs ADD COLUMN template_id INTEGER REFERENCES job_templates(id) ON DELETE SET NULL'); } catch {}
    try { db.exec('ALTER TABLE jobs ADD COLUMN run_every_days INTEGER NOT NULL DEFAULT 1'); } catch {}
  });

  it('all existing jobs survive the migration', () => {
    const accId = db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Alice', '+61400000001', 1, 'h').lastInsertRowid;
    db.prepare('INSERT INTO jobs (name, account_id, bot_username, start_command, checkin_button, run_every_days) VALUES (?, ?, ?, ?, ?, ?)').run('Morning Checkin', accId, '@mybot', '/start', '签到', 3);
    db.prepare('INSERT INTO jobs (name, account_id, bot_username) VALUES (?, ?, ?)').run('Evening Job', accId, '@other');

    db.exec(JOBS_V2_MIGRATION);

    const jobs = db.prepare('SELECT * FROM jobs ORDER BY id').all() as any[];
    expect(jobs).toHaveLength(2);
    expect(jobs[0].name).toBe('Morning Checkin');
    expect(jobs[0].account_id).toBe(Number(accId));
    expect(jobs[0].run_every_days).toBe(3);
    expect(jobs[1].name).toBe('Evening Job');
  });

  it('job configs survive the migration', () => {
    const accId = db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Bob', '+61400000002', 1, 'h').lastInsertRowid;
    const config = JSON.stringify({ embyUrl: 'http://emby:8096', username: 'user1' });
    db.prepare('INSERT INTO jobs (name, account_id, bot_username, config) VALUES (?, ?, ?, ?)').run('Emby Job', accId, '', config);

    db.exec(JOBS_V2_MIGRATION);

    const job = db.prepare('SELECT * FROM jobs WHERE name = ?').get('Emby Job') as any;
    expect(job.config).toBe(config);
  });

  it('job logs are preserved and still reference the correct job after migration', () => {
    // Use NO ACTION (not CASCADE) so DROP TABLE jobs does not remove the logs.
    // In the production schema, job_logs uses ON DELETE CASCADE, but CASCADE is triggered
    // by DELETE statements -- SQLite does not apply it on DROP TABLE, so logs survive
    // as long as the new jobs table reuses the same IDs (which INSERT INTO jobs_v2 SELECT * does).
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_logs (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        ran_at TEXT    NOT NULL,
        status TEXT    NOT NULL DEFAULT 'success'
      )
    `);
    const accId = db.prepare('INSERT INTO tg_accounts (name, phone_number, api_id, api_hash) VALUES (?, ?, ?, ?)').run('Alice', '+61400000001', 1, 'h').lastInsertRowid;
    const jobId = db.prepare('INSERT INTO jobs (name, account_id, bot_username) VALUES (?, ?, ?)').run('Job', accId, '@bot').lastInsertRowid;
    db.prepare('INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, ?)').run(jobId, '2024-01-01T10:00:00Z', 'success');

    db.exec(JOBS_V2_MIGRATION);

    const log = db.prepare('SELECT * FROM job_logs').get() as any;
    expect(log.job_id).toBe(Number(jobId));
    // IDs are preserved by INSERT INTO jobs_v2 SELECT *, so the reference is still valid
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(log.job_id) as any;
    expect(job.name).toBe('Job');
  });
});
