import type { Sort } from "mongodb";

import { fuzzyScore } from "./fuzzy";

/**
 * SQLite-isms mapped onto MongoDB.
 *
 * The two engines disagree about three things Bemby leaned on, and the whole point of these
 * helpers is that no call site has to remember which is which.
 */

/**
 * SQLite's LIKE is case-insensitive for ASCII (unless PRAGMA case_sensitive_like is on, which
 * Bemby never set), so a `$regex` without `i` would silently narrow every search box in the
 * UI. `%foo%` becomes an anchored-free pattern with the user's metacharacters escaped -- they
 * searched for text, not for a regular expression.
 */
export function like(value: string): { $regex: string; $options: string } {
  return { $regex: escapeRegex(value), $options: "i" };
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `= value` on a column SQLite defaulted to 0, where Mongo's documents simply omit it. */
export function coalesceZero(value: number): unknown {
  return value === 0 ? { $in: [0, null] } : value;
}

/** `column IS NULL` in SQLite vs `column: null` in Mongo (which also matches missing). */
export const isNull = null;

/**
 * SQLite's `ORDER BY x COLLATE NOCASE`, which has no Mongo equivalent: the collation lives on
 * the query, not the index. `strength: 2` is "ignore case" and nothing more.
 */
export const NOCASE = { locale: "en", strength: 2 } as const;

/**
 * Builds a Mongo sort from the app's `sort=name&order=desc` query pair.
 * Returns null when the caller wants relevance ordering instead.
 */
export function buildSort(
  key: string | undefined,
  order: unknown,
  sorts: Record<string, Sort>,
  fallback: Sort,
): Sort {
  if (!key) return fallback;
  const chosen = sorts[key] ?? fallback;
  if (String(order).toLowerCase() !== "desc") return chosen;
  return Object.fromEntries(
    Object.entries(chosen).map(([k, v]) => [k, (v as number) * -1]),
  ) as Sort;
}

/**
 * Fuzzy relevance ranking, lifted out of SQLite.
 *
 * `fuzzy_score` was a user-defined SQLite function, which has no counterpart here. Scoring in
 * JS instead costs a scan of the candidate set -- fine for the lists that use it (templates,
 * typically dozens of rows) and it keeps the ranking identical rather than approximating it
 * with a regex, which would order the results differently and quietly change what people see.
 */
export function rankByFuzzy<T>(
  rows: T[],
  needle: string,
  haystack: (row: T) => string,
): Array<T & { search_score: number }> {
  return rows
    .map((row) => ({ ...row, search_score: fuzzyScore(needle, haystack(row)) }))
    .filter((r) => r.search_score > 0)
    .sort((a, b) => b.search_score - a.search_score) as Array<T & { search_score: number }>;
}
