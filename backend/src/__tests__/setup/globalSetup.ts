import fs from "fs";
import os from "os";
import path from "path";

import { MongoMemoryReplSet } from "mongodb-memory-server";

/**
 * One in-memory MongoDB for the whole run.
 *
 * The suite used to hand every test file its own throwaway SQLite file, which cost nothing
 * and could be built inside a `beforeAll`. MongoDB has no equivalent: the smallest usable
 * server is a real `mongod` on a real port, and the data layer now reaches the store through
 * a connection instead of a handle passed around in-process. So the server starts once here,
 * before any test file is loaded, and every file connects to it.
 *
 * A replica set, which is more than the application itself needs: every former
 * `db.transaction()` block became sequential awaits precisely so that a standalone mongod --
 * which a single-node install runs -- is enough. It is a replica set here only because two
 * test files still call `db.transaction()` directly (general-functionality,
 * data-export-import), and a standalone mongod refuses transactions. If those are ever
 * rewritten against the repositories, this can drop to `MongoMemoryServer` and boot faster.
 *
 * The URI reaches the workers through a file as well as the environment. globalSetup runs in
 * the main process, and a worker that was already forked would not see a later change to
 * `process.env`.
 */

export const TEST_DB_NAME = "bemby_test";

/** Where globalSetup leaves the connection for the workers to pick up. */
export function mongoUriFile(): string {
  return (
    process.env.BEMBY_TEST_MONGO_FILE ??
    path.join(os.tmpdir(), `bemby-test-mongo-${process.pid}.json`)
  );
}

/**
 * Where a test-run's panel config would be written.
 *
 * Pointed at a temp file so a run can never read the developer's real `data/database.json` --
 * which would send the suite at a real database -- and so a test that saves a config does not
 * leave one behind.
 */
export function dbConfigFile(): string {
  return path.join(os.tmpdir(), `bemby-test-dbconfig-${process.pid}.json`);
}

export default async function setup() {
  const replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, name: "bembyrs" },
  });

  const uri = replset.getUri(TEST_DB_NAME);

  process.env.MONGODB_URI = uri;
  process.env.MONGODB_DB = TEST_DB_NAME;
  process.env.BEMBY_DB_CONFIG = dbConfigFile();
  fs.writeFileSync(mongoUriFile(), JSON.stringify({ uri, dbName: TEST_DB_NAME }));

  return async () => {
    await replset.stop().catch(() => {});
    for (const file of [mongoUriFile(), dbConfigFile()]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* nothing to clean up */
      }
    }
  };
}
