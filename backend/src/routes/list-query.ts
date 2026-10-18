// Shared helpers for list endpoints with opt-in server-side pagination.
// When the request carries a `page` (or `pageSize`) param the endpoint returns
// `{ items, total, page, pageSize }`; without it the legacy full-array shape is kept
// so existing dropdown/consumer callers keep working.

export type Paging = { page: number; pageSize: number; limit: number; offset: number };

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 25;

/** What the list views send for their "All" page size: one page holding every row. */
export const ALL_PAGE_SIZE = 0;

export function parsePaging(query: Record<string, unknown>): Paging | null {
  if (query.page === undefined && query.pageSize === undefined) return null;
  // "All" is a single page with no ceiling. SQLite reads a negative LIMIT as no limit, so
  // the endpoints keep their `LIMIT ? OFFSET ?` shape rather than growing a second query.
  if (isAllPageSize(query.pageSize)) {
    return { page: 1, pageSize: ALL_PAGE_SIZE, limit: -1, offset: 0 };
  }
  const page = clampInt(query.page, 1, 1_000_000, 1);
  const pageSize = clampInt(query.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

function isAllPageSize(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  const n = Number(value);
  return Number.isFinite(n) && n <= 0;
}

// Maps a client sortKey to a whitelisted ORDER BY expression; unknown keys fall back.
export function parseSort(
  query: Record<string, unknown>,
  allowed: Record<string, string>,
  fallback: string,
): string {
  const key = typeof query.sortKey === "string" ? query.sortKey : "";
  const expr = allowed[key] ?? fallback;
  const dir = query.sortDir === "desc" ? "DESC" : "ASC";
  return `${expr} ${dir}`;
}

export function textParam(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Escapes LIKE wildcards in user input; pair with `LIKE ? ESCAPE '\'`
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
