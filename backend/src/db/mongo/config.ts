import fs from "fs";
import path from "path";

/**
 * Where Bemby itself records the database connection.
 *
 * MongoDB replaced SQLite as the store, which leaves one value the database
 * cannot hold: the address of the database. Bemby has to know where to connect
 * before it can read or write anything, so that one value lives outside it, in
 * a small file beside the app data.
 *
 * Precedence, highest first:
 *   1. The operator filling in the panel -- written to this file by PUT /api/database/config
 *   2. MONGODB_URI in the environment (with MONGODB_DB for the database name)
 *
 * The file wins over the environment deliberately: whoever set the environment
 * did it once, at deploy time, and the panel is the answer someone reached for
 * precisely because they could not restart the container to change it.
 */
export type DbConfig = {
  uri: string;
  dbName: string;
  /** Where this connection came from, so the panel can explain itself. */
  source: "ui" | "env" | "none";
  /** When the panel last wrote it; absent for connections taken from the environment. */
  updatedAt?: string;
};

export const DEFAULT_DB_NAME = "bemby";

export function getDbConfigPath(): string {
  return (
    process.env.BEMBY_DB_CONFIG ?? path.resolve(process.cwd(), "data/database.json")
  );
}

/** Reads the connection recorded by the panel. Returns null when there is nothing there yet. */
function readConfigFile(file: string): DbConfig | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<DbConfig>;
    if (!parsed?.uri) return null;
    return {
      uri: String(parsed.uri),
      dbName: parsed.dbName || dbNameFromUri(String(parsed.uri)) || DEFAULT_DB_NAME,
      source: "ui",
      updatedAt: parsed.updatedAt,
    };
  } catch (e) {
    // A corrupt config file must not hide the fact that it exists: falling through to the
    // environment here would leave Bemby running against a different database than the one
    // the operator thinks they configured, writing into whichever of the two answers first.
    console.error(`[db] could not read ${file}:`, e);
    return null;
  }
}

/**
 * Pulls the database name out of a connection string, which is where it usually lives --
 * `mongodb://host:27017/<dbName>?<options>`. `admin` and empty mean "no name given": MongoDB
 * connects to either happily, and neither is a name anyone picked for their data.
 */
export function dbNameFromUri(uri: string): string | null {
  try {
    const afterScheme = uri.slice(uri.indexOf("//") + 2);
    const pathStart = afterScheme.indexOf("/");
    if (pathStart === -1) return null;
    const rest = afterScheme.slice(pathStart + 1);
    if (!rest) return null;
    const name = decodeURIComponent(rest.split("?")[0]);
    return name && name !== "admin" ? name : null;
  } catch {
    return null;
  }
}

/** The connection Bemby should use right now, or source:"none" when nothing is configured. */
export function loadDbConfig(): DbConfig {
  const fromFile = readConfigFile(getDbConfigPath());
  if (fromFile) return fromFile;

  const envUri = process.env.MONGODB_URI?.trim();
  if (envUri) {
    return {
      uri: envUri,
      dbName:
        process.env.MONGODB_DB?.trim() ||
        dbNameFromUri(envUri) ||
        DEFAULT_DB_NAME,
      source: "env",
    };
  }

  return { uri: "", dbName: DEFAULT_DB_NAME, source: "none" };
}

/** Writes the panel's connection down. Returns the config as it will be read back. */
export function saveDbConfig(uri: string, dbName?: string): DbConfig {
  const trimmed = uri.trim();
  const resolvedName = dbName?.trim() || dbNameFromUri(trimmed) || DEFAULT_DB_NAME;
  const config: DbConfig = {
    uri: trimmed,
    dbName: resolvedName,
    source: "ui",
    updatedAt: new Date().toISOString(),
  };

  const file = getDbConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0600 rather than the default 0644: the URI carries the database password in clear text,
  // and the app data directory is shared with things nothing else has reason to read.
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}

/**
 * Drops the panel's connection so Bemby falls back to MONGODB_URI, or to unconfigured.
 * Used by "disconnect" in the panel. Deliberately does not touch the database itself.
 */
export function clearDbConfig(): void {
  const file = getDbConfigPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
