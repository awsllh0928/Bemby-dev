import { getAccount, updateAccount } from "./repos/accounts";

// Loose per-account metadata bag stored as JSON in tg_accounts.additional_attributes.
// Holds UI-safe flags such as email or restriction status. The passkey secret lives in
// its own tg_accounts.passkey column (see tg/passkeyStore.ts), never in this bag.
export type AccountAttributes = Record<string, unknown>;

// Legacy settings key where passkeys lived before they moved onto the account row.
// Retained so old backups can still be recognised (and skipped) on import.
export const LEGACY_PASSKEY_STORE_KEY = "tg_passkey_secrets";

export function parseAttributes(
  raw: string | null | undefined,
): AccountAttributes {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as AccountAttributes) : {};
  } catch {
    return {};
  }
}

export async function getAttributes(accountId: number): Promise<AccountAttributes> {
  const row = await getAccount(accountId);
  return parseAttributes(row?.additional_attributes);
}

export async function writeAttributes(
  accountId: number,
  attrs: AccountAttributes,
): Promise<void> {
  const empty = !attrs || Object.keys(attrs).length === 0;
  await updateAccount(accountId, {
    additional_attributes: empty ? null : JSON.stringify(attrs),
  });
}

// Merge a partial patch into the bag; a key set to undefined is removed.
export async function patchAttributes(
  accountId: number,
  patch: AccountAttributes,
): Promise<void> {
  const next = { ...(await getAttributes(accountId)) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  await writeAttributes(accountId, next);
}

// The bag as safe to expose to the UI. Defence in depth: strips a `passkey` key in case
// a legacy row still has the secret embedded (it belongs in the dedicated passkey column).
export function publicAttributes(attrs: AccountAttributes): AccountAttributes {
  const { passkey: _passkey, ...rest } = attrs;
  return rest;
}

// The attributes bag to store for an imported account (null when absent/empty).
export function foldImportedAttributes(item: any): AccountAttributes | null {
  const bag = item?.additionalAttributes;
  if (bag && typeof bag === "object" && Object.keys(bag).length) {
    return bag as AccountAttributes;
  }
  return null;
}
