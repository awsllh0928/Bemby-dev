import { randomUUID } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Runs before every test file, and only fixes up the environment.
 *
 * It deliberately does not connect: most of the suite is pure logic and would pay a round
 * trip for a database it never touches. Files that need rows call `initTestDb()` from
 * `helpers/db.ts`, which is idempotent.
 *
 * Reading a file rather than trusting `process.env` alone is what makes this safe under any
 * pool: globalSetup sets both, but a worker forked before it ran would only have the file.
 */
function mongoUriFile(): string {
  return (
    process.env.BEMBY_TEST_MONGO_FILE ??
    path.join(os.tmpdir(), `bemby-test-mongo-${process.ppid}.json`)
  );
}

function applyEnv(): void {
  if (!process.env.MONGODB_URI) {
    const file = mongoUriFile();
    if (!fs.existsSync(file)) {
      throw new Error(
        `没有找到 MongoDB 测试实例: ${file} 不存在。请确认 vitest.config.ts 配置了 globalSetup。`,
      );
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      uri: string;
      dbName: string;
    };
    process.env.MONGODB_URI = parsed.uri;
  }

  // Must not resolve to the developer's own data/database.json: that file wins over the
  // environment, and it points at their real database.
  process.env.BEMBY_DB_CONFIG =
    process.env.BEMBY_DB_CONFIG ??
    path.join(os.tmpdir(), `bemby-test-dbconfig-${process.ppid}.json`);

  // Its own database per test file.
  //
  // Vitest runs files concurrently, and `resetDb` empties every collection: sharing one
  // database would have two files deleting each other's rows between assertions. This runs
  // once per file, and each file's `initDb()` reads the name from here.
  process.env.MONGODB_DB = `bemby_test_${randomUUID().slice(0, 8)}`;
}

applyEnv();
