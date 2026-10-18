import type { Filter, Sort } from "mongodb";

import { col } from "../collection";
import { getDb } from "../mongo/client";
import { nextId } from "../mongo/ids";
import { NOCASE, buildSort, like } from "../query";
import type { AccountDoc } from "../types";

function accountsCol() {
  return col<AccountDoc>("tg_accounts");
}

export type AccountSortKey = "order" | "name" | "phone" | "status" | "created";

const SORTS: Record<AccountSortKey, Sort> = {
  order: { sort_order: 1, _id: 1 },
  name: { name: 1 },
  phone: { phone_number: 1 },
  status: { auth_status: 1 },
  created: { created_at: 1 },
};

/**
 * The SQLite schema's sort column list. `name COLLATE NOCASE` has no index-side answer in
 * Mongo, so the sort is paired with the collation instead. Everything else is a plain field.
 */
export function accountSort(key: string | undefined, order: unknown): Sort {
  return buildSort(key, order, SORTS, SORTS.order);
}

/** Case-insensitive collation only matters for name sorting; Mongo will not accept it on
 *  every other query's behalf. */
export function accountCollation(key: string | undefined) {
  return key === "name" ? NOCASE : undefined;
}

/** The free-text filter the accounts list built with five OR'd LIKE clauses. */
export function searchFilter(search: string | undefined): Filter<AccountDoc>["$or"] {
  if (!search) return undefined;
  const pattern = like(search);
  return [
    { name: pattern },
    { phone_number: pattern },
    { tg_display_name: pattern },
    { tg_username: pattern },
    { notes: pattern },
  ];
}

export async function getAccount(id: number): Promise<AccountDoc | null> {
  return accountsCol().findOne({ _id: id });
}

export async function getAccounts(ids: number[]): Promise<AccountDoc[]> {
  if (!ids.length) return [];
  return accountsCol().find({ _id: { $in: ids } }).sort({ _id: 1 }).toArray();
}

export async function listAccounts(): Promise<AccountDoc[]> {
  return accountsCol().find({}).toArray();
}

export async function countAccounts(filter: Filter<AccountDoc> = {}): Promise<number> {
  return accountsCol().countDocuments(filter);
}

export async function findAccountByPhone(phone: string): Promise<AccountDoc | null> {
  return accountsCol().findOne({ phone_number: phone });
}

export async function maxSortOrder(): Promise<number> {
  const rows = await accountsCol().find({}, { sort: { sort_order: -1 }, limit: 1 }).toArray();
  return rows[0]?.sort_order ?? 0;
}

export type CreateAccountInput = {
  name: string;
  phone_number: string;
  api_id?: number | null;
  api_hash?: string | null;
  session_string?: string | null;
  auth_status?: string;
  proxy_id?: string | null;
  app_client_id?: string | null;
  disabled?: number;
  sort_order?: number;
  notes?: string | null;
};

/** Returns the new id, as SQLite's lastInsertRowid did. */
export async function createAccount(input: CreateAccountInput): Promise<number> {
  const id = await nextId(getDb(), "tg_accounts");
  await accountsCol().insertOne({
    _id: id,
    name: input.name,
    phone_number: input.phone_number,
    api_id: input.api_id ?? null,
    api_hash: input.api_hash ?? null,
    session_string: input.session_string ?? null,
    auth_status: input.auth_status ?? "unauthenticated",
    created_at: new Date().toISOString(),
    proxy_id: input.proxy_id ?? null,
    disabled: input.disabled ?? 0,
    app_client_id: input.app_client_id ?? null,
    sort_order: input.sort_order ?? 0,
    notes: input.notes ?? null,
  } as AccountDoc);
  return id;
}

export async function updateAccount(
  id: number,
  patch: Partial<Omit<AccountDoc, "_id">>,
): Promise<void> {
  if (!Object.keys(patch).length) return;
  await accountsCol().updateOne({ _id: id }, { $set: patch });
}

/**
 * Deletes an account.
 *
 * SQLite removed its dependents for free: `jobs.account_id` was declared ON DELETE SET NULL
 * and matching rows disappeared with the parent. MongoDB has no foreign keys, so that has to
 * happen here -- otherwise deleting an account would leave jobs pointing at nothing, and the
 * job list would render a blank where its account used to be.
 */
export async function deleteAccount(id: number): Promise<void> {
  await accountsCol().deleteOne({ _id: id });
  await col("jobs").updateMany({ account_id: id }, { $set: { account_id: null } });
}
