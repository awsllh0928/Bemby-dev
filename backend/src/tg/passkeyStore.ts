import { col } from "../db/collection";
import { updateAccount } from "../db/repos/accounts";
import type { AccountDoc } from "../db/types";
import { decryptSecret, encryptSecret } from "../db/secretColumns";

// Bemby stores a single passkey per account in the dedicated tg_accounts.passkey column
// (JSON). One passkey per account keeps export/import trivial: the passkey travels with
// the account and needs no id remapping. It is kept in its own column, out of the UI-safe
// additional_attributes bag, because it holds a private key -- treat as sensitive and
// never serialise it to the client.

export type PasskeySecret = {
  accountId: number;
  telegramPasskeyId: string;
  credentialId: string; // base64url, used for the assertion's id/raw_id
  privateKeyPem: string;
  rpId: string;
  userHandle: string; // base64url user.id from the registration options
  createdDate: number;
  // Account's home DC, captured while a session exists so passkey login still
  // works after force-reauth clears the session string.
  dcId?: number;
  serverAddress?: string;
  port?: number;
};

// The persisted form omits accountId -- it is the row's own id, injected on read.
export type StoredPasskey = Omit<PasskeySecret, "accountId">;

/**
 * Reads the stored passkey. The column is encrypted at rest when a data key is configured
 * (see db/secretColumns), so decryption happens here, at the one place the raw column value
 * is turned into an object, rather than at every caller.
 */
export function parseStoredPasskey(
  raw: string | null | undefined,
): StoredPasskey | null {
  const plain = decryptSecret(raw ?? null);
  if (!plain) return null;
  try {
    const value = JSON.parse(plain);
    return value && typeof value === "object" ? (value as StoredPasskey) : null;
  } catch {
    return null;
  }
}

export async function getAccountPasskey(
  accountId: number,
): Promise<PasskeySecret | null> {
  // SELECT passkey FROM tg_accounts WHERE id = ?
  const row = await col<AccountDoc>("tg_accounts").findOne(
    { _id: accountId },
    { projection: { passkey: 1 } },
  );
  const stored = parseStoredPasskey(row?.passkey);
  return stored ? { accountId, ...stored } : null;
}

export async function savePasskeySecret(secret: PasskeySecret): Promise<void> {
  const { accountId, ...stored } = secret;
  // UPDATE tg_accounts SET passkey = ? WHERE id = ?
  await updateAccount(accountId, {
    passkey: encryptSecret(JSON.stringify(stored)),
  });
}

export async function getPasskeySecret(
  telegramPasskeyId: string,
): Promise<PasskeySecret | undefined> {
  // SELECT id, passkey FROM tg_accounts WHERE passkey IS NOT NULL
  const rows = await col<AccountDoc>("tg_accounts")
    .find({ passkey: { $ne: null } }, { projection: { passkey: 1 } })
    .toArray();
  for (const r of rows) {
    const stored = parseStoredPasskey(r.passkey);
    if (stored?.telegramPasskeyId === telegramPasskeyId)
      return { accountId: r._id, ...stored };
  }
  return undefined;
}

async function clearPasskey(accountId: number): Promise<void> {
  // UPDATE tg_accounts SET passkey = NULL WHERE id = ?
  await updateAccount(accountId, { passkey: null });
}

export async function deletePasskeySecret(
  telegramPasskeyId: string,
): Promise<void> {
  const secret = await getPasskeySecret(telegramPasskeyId);
  if (secret) await clearPasskey(secret.accountId);
}

// Drop the stored secret when its passkey no longer exists on Telegram.
export async function pruneAccountPasskeySecrets(
  accountId: number,
  liveIds: string[],
): Promise<void> {
  const secret = await getAccountPasskey(accountId);
  if (secret && !liveIds.includes(secret.telegramPasskeyId))
    await clearPasskey(accountId);
}

// Telegram passkey ids we hold the private key for (0 or 1 for a given account).
export async function storedPasskeyIdsForAccount(
  accountId: number,
): Promise<string[]> {
  const secret = await getAccountPasskey(accountId);
  return secret ? [secret.telegramPasskeyId] : [];
}

// Kept returning an array so existing callers (export, .find(dcId)) are unchanged.
export async function accountPasskeySecrets(
  accountId: number,
): Promise<PasskeySecret[]> {
  const secret = await getAccountPasskey(accountId);
  return secret ? [secret] : [];
}

// Backfill/refresh the account's home DC on the stored secret.
export async function setAccountPasskeyDc(
  accountId: number,
  dc: { dcId: number; serverAddress: string; port: number },
): Promise<void> {
  const secret = await getAccountPasskey(accountId);
  if (!secret) return;
  await savePasskeySecret({ ...secret, ...dc });
}

// Resolves the passkey to store for an imported account, tolerating older export shapes:
// a single `passkey` object (current), or a `passkeys` array (interim builds).
export function importedPasskeyFor(item: any): StoredPasskey | null {
  const raw =
    item?.passkey && typeof item.passkey === "object"
      ? item.passkey
      : Array.isArray(item?.passkeys)
        ? item.passkeys.find((p: any) => p?.dcId != null) ?? item.passkeys[0]
        : null;
  if (!raw || typeof raw !== "object") return null;
  const { accountId: _omit, ...stored } = raw as Record<string, unknown>;
  return stored as unknown as StoredPasskey;
}
