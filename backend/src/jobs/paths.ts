import path from "node:path";

/**
 * The directory the database sits in. Everything the Cloudflare solver downloads on demand
 * (browser, profiles, fonts) goes here, because it is the one place that is a volume and so
 * survives a restart and an upgrade. Read on every call: tests move DB_PATH around.
 */
export function dataDir(): string {
  return path.dirname(process.env.DB_PATH ?? path.resolve(process.cwd(), "data/bemby.db"));
}
