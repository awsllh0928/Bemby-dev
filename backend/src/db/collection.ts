import type { Collection, Document } from "mongodb";

import { getDb } from "./mongo/client";

/**
 * A typed handle on one collection.
 *
 * This is what replaced `db.prepare("SELECT ...")`. Anything a repository does not cover is
 * written straight against the collection, which is the idiomatic MongoDB shape and keeps an
 * odd one-off query from forcing a new method onto a repository nobody else will call.
 *
 * Kept in its own file so repositories can use it without importing through db/database.ts
 * and closing an import cycle through the helpers that import them back.
 */
export function col<T extends Document = Document>(name: string): Collection<T> {
  return getDb().collection<T>(name);
}
