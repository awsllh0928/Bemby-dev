import { Router } from "express";
import type { Filter } from "mongodb";
import { getDefaultTgApiCredentials } from "../db/database";
import { col } from "../db/collection";
import { coalesceZero } from "../db/query";
import type { AccountDoc, JobDoc } from "../db/types";
import {
  accountCollation,
  accountSort,
  countAccounts,
  createAccount,
  deleteAccount,
  findAccountByPhone,
  getAccount,
  maxSortOrder,
  searchFilter,
  updateAccount,
} from "../db/repos/accounts";
import { NOT_RETIRED } from "../db/repos/jobs";
import { getSetting } from "../db/repos/settings";
import { parsePaging, textParam } from "./list-query";
import {
  requestCode,
  submitCode,
  submitPassword,
  checkAccountStatus,
  resendCodeAsSms,
  updateTwoFa,
  getProfile,
  updateProfile,
  getSessions,
  terminateSession,
  terminateOtherSessions,
  getPasswordInfo,
  sendLoginEmailCode,
  verifyLoginEmail,
  getPasskeys,
  deletePasskey,
  registerPasskey,
  verifyPasskeyLogin,
  startPasskeyLogin,
  getSessionDc,
  type PasswordInfo,
} from "../auth/tgAuth";
import { checkSpamStatus } from "../jobs/checkin";
import { generateProfiles } from "../jobs/profileGen";
import {
  startBulkAdd,
  getBulkAddStatus,
  cancelBulkAdd,
  isBulkAccountManagementEnabled,
  type BulkAddOptions,
} from "../jobs/bulkAdd";
import {
  startBulkProfile,
  getBulkProfileStatus,
  cancelBulkProfile,
  type BulkProfileEntry,
  type BulkProfileOptions,
} from "../jobs/bulkProfile";
import {
  changeLoginEmailViaGmail,
  testGmailImap,
} from "../jobs/bulkLoginEmail";
import type { AuthStatus } from "../types";
import { parseTgProxy } from "../jobs/runner";
import { resolveAppClientParams, previewDeviceModel } from "../tg/appClient";
import { isAuthError, markSessionExpired } from "../tg/liveClient";
import {
  savePasskeySecret,
  getPasskeySecret,
  deletePasskeySecret,
  storedPasskeyIdsForAccount,
  accountPasskeySecrets,
  parseStoredPasskey,
  importedPasskeyFor,
  setAccountPasskeyDc,
  pruneAccountPasskeySecrets,
} from "../tg/passkeyStore";
import {
  parseAttributes,
  publicAttributes,
  writeAttributes,
  patchAttributes,
  foldImportedAttributes,
} from "../db/accountAttributes";
import { refreshScheduler } from "../scheduler";
import {
  decryptPayload,
  encryptPayload,
  type EncryptedEnvelope,
} from "../db/exportCrypto";
import { decryptAccountRow, encryptSecret } from "../db/secretColumns";

// Reasons set by checkAccountStatus for frozen/revoked sessions that need re-auth
const REAUTH_REASONS = new Set([
  "auth_key_duplicated",
  "session_revoked",
  "auth_key_unregistered",
  "account_frozen",
]);

function statusNeedsReauth(
  status: import("../auth/tgAuth").TgAccountStatus,
): boolean {
  return status.restrictions.some((r) =>
    REAUTH_REASONS.has(r.reason.toLowerCase()),
  );
}

function internalError(res: import('express').Response, err: unknown, context: string): void {
  console.error(`[accounts] ${context}:`, err);
  res.status(500).json({ error: 'An internal error occurred' });
}

// Surface Telegram RPC refusals (e.g. EMAIL_NOT_ALLOWED) as a 400 with the raw
// error code so the frontend can translate them; returns false for other errors.
function rpcBadRequest(res: import('express').Response, err: any, context: string): boolean {
  if (typeof err?.errorMessage !== "string" || typeof err?.code !== "number") return false;
  console.warn(`[accounts] ${context}: RPC ${err.errorMessage}`);
  res.status(400).json({ error: err.errorMessage });
  return true;
}

const router = Router();

/** The account document as the handlers below read it: Mongo's `_id` answers to `id` here. */
type AccountRow = Omit<AccountDoc, "_id" | "auth_status"> & {
  id: number;
  auth_status: AuthStatus;
};

function toAccountRow(doc: AccountDoc): AccountRow {
  const { _id, ...rest } = doc;
  return { ...rest, id: _id, auth_status: doc.auth_status as AuthStatus };
}

/**
 * Loads one account with its credential columns decrypted. Every handler below goes through
 * this rather than querying directly, so the decryption cannot be forgotten at a call site
 * (see db/secretColumns for why the columns are encrypted at all).
 */
async function loadAccount(
  id: string | number | bigint,
): Promise<AccountRow | undefined> {
  const doc = await getAccount(Number(id));
  return doc ? decryptAccountRow(toAccountRow(doc)) : undefined;
}

/** Resolves effective API credentials, falling back to global defaults. Throws if neither is set. */
async function resolveApiCredentials(account: AccountRow): Promise<{
  apiId: number;
  apiHash: string;
}> {
  const ownCredentials =
    account.api_id && account.api_hash
      ? { apiId: account.api_id, apiHash: account.api_hash }
      : null;
  const credentials = ownCredentials ?? (await getDefaultTgApiCredentials());
  const apiId = credentials?.apiId;
  const apiHash = credentials?.apiHash;
  if (!apiId || !apiHash) {
    throw new Error(
      "No API credentials available. Add credentials to this account or configure global defaults in Settings.",
    );
  }
  return { apiId, apiHash };
}

async function resolveProxyUrl(
  proxyId: string | null | undefined,
): Promise<string | undefined> {
  if (!proxyId) return undefined;
  try {
    const value = await getSetting("proxies");
    if (!value) return undefined;
    const list = JSON.parse(value) as Array<{ id: string; url: string }>;
    return list.find((p) => p.id === proxyId)?.url;
  } catch {
    return undefined;
  }
}

async function toJson(row: AccountRow) {
  const attributes = await parseAttributes(row.additional_attributes);
  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone_number,
    apiId: row.api_id ?? null,
    // apiHash intentionally omitted from responses
    /** True when the account has no per-account credentials and relies on global defaults. */
    usesDefaultCredentials: !row.api_id || !row.api_hash,
    authStatus: row.auth_status,
    proxyId: row.proxy_id ?? null,
    disabled: Boolean(row.disabled),
    appClientId: row.app_client_id ?? null,
    createdAt: row.created_at,
    sortOrder: row.sort_order ?? 0,
    tgDisplayName: row.tg_display_name ?? null,
    tgUsername: row.tg_username ?? null,
    notes: row.notes ?? null,
    resolvedDeviceModel: await previewDeviceModel(row.id, row.app_client_id),
    // Generic UI-safe flags; the passkey secret is deliberately never included here.
    attributes: await publicAttributes(attributes),
    // Whether the Telegram account has ANY passkey (any device/origin). Sourced from the
    // stored flag, refreshed whenever Bemby lists the account's passkeys.
    hasPasskey: (attributes.hasPasskey as boolean | undefined) ?? false,
    // Whether Bemby holds a stored passkey usable for login (its home DC is known).
    hasBembyPasskey: parseStoredPasskey(row.passkey)?.dcId != null,
  };
}

async function saveTgMeta(
  id: number,
  firstName: string,
  lastName: string | undefined,
  username: string | undefined,
) {
  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  await updateAccount(id, {
    tg_display_name: displayName || null,
    tg_username: username || null,
  });
}

function accountsCol() {
  return col<AccountDoc>("tg_accounts");
}

router.get("/", async (req, res) => {
  try {
    const query = req.query as Record<string, unknown>;
    const paging = parsePaging(query);
    const search = textParam(query.search);
    const authStatus = textParam(query.authStatus);
    const disabled = textParam(query.disabled);

    const conditions: Array<Filter<AccountDoc>> = [];

    const searchClause = searchFilter(search);
    if (searchClause) conditions.push({ $or: searchClause });
    if (authStatus) conditions.push({ auth_status: authStatus });
    if (disabled === "1" || disabled === "0") {
      // COALESCE(disabled, 0): a document written before the column existed omits it.
      conditions.push({
        disabled: coalesceZero(Number(disabled)) as AccountDoc["disabled"],
      });
    }
    const filter: Filter<AccountDoc> = conditions.length
      ? { $and: conditions }
      : {};

    const sortKey = textParam(query.sortKey) || undefined;
    let cursor = accountsCol()
      .find(filter)
      .sort(accountSort(sortKey, query.sortDir));
    const collation = accountCollation(sortKey);
    if (collation) cursor = cursor.collation(collation);
    if (paging) {
      cursor = cursor.skip(paging.offset);
      // "All" is one unbounded page, which SQLite got from a negative LIMIT. Mongo reads a
      // negative limit as its absolute value, so the ceiling is simply left off here.
      if (paging.limit > 0) cursor = cursor.limit(paging.limit);
    }
    const rows = (await cursor.toArray()).map(toAccountRow);
    rows.forEach(decryptAccountRow);

    if (!paging) {
      res.json(await Promise.all(rows.map(toJson)));
      return;
    }

    res.json({
      items: await Promise.all(rows.map(toJson)),
      total: await countAccounts(filter),
      page: paging.page,
      pageSize: paging.pageSize,
    });
  } catch (err) {
    internalError(res, err, "list");
  }
});

router.post("/", async (req, res) => {
  const { name, phoneNumber, apiId, apiHash, proxyId, appClientId, notes } =
    req.body as Record<string, string>;
  if (!name || !phoneNumber) {
    res.status(400).json({ error: "name and phoneNumber are required" });
    return;
  }
  try {
    // API credentials required unless global defaults are configured
    if ((!apiId || !apiHash) && !(await getDefaultTgApiCredentials())) {
      res.status(400).json({
        error:
          "apiId and apiHash are required (or configure global defaults in Settings)",
      });
      return;
    }

    const id = await createAccount({
      name,
      phone_number: phoneNumber,
      api_id: apiId ? Number(apiId) : null,
      api_hash: encryptSecret(apiHash || null),
      proxy_id: proxyId || null,
      app_client_id: appClientId || null,
      sort_order: (await maxSortOrder()) + 1,
      notes: notes || null,
    });

    const row = (await loadAccount(id)) as AccountRow;
    res.status(201).json(await toJson(row));
  } catch (err) {
    internalError(res, err, "create");
  }
});

// POST /bulk-add -- create accounts from "phone----apiUrl" lines, then
// authenticate them one by one using codes/2FA served by each API page
// Reject bulk-management requests unless enabled via BULK_ACCOUNT_MANAGEMENT
const bulkMgmtGuard: import("express").RequestHandler = (_req, res, next) => {
  if (!isBulkAccountManagementEnabled()) {
    res.status(403).json({ error: "Bulk account management is not enabled" });
    return;
  }
  next();
};

router.post("/bulk-add", bulkMgmtGuard, async (req, res) => {
  const { text, options } = req.body as {
    text?: string;
    options?: BulkAddOptions;
  };
  if (!text || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    const result = await startBulkAdd(text, options);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result.batch);
  } catch (err) {
    internalError(res, err, "bulk-add");
  }
});

// GET /bulk-add/status -- current batch progress (null if none has run)
router.get("/bulk-add/status", bulkMgmtGuard, (_req, res) => {
  res.json(getBulkAddStatus());
});

// POST /bulk-add/cancel -- stop the running batch after the current step
router.post("/bulk-add/cancel", bulkMgmtGuard, (_req, res) => {
  res.json({ cancelled: cancelBulkAdd() });
});

// POST /bulk-profile -- update first/last name + bio on many accounts at once
router.post("/bulk-profile", bulkMgmtGuard, async (req, res) => {
  const { items, options } = req.body as {
    items?: BulkProfileEntry[];
    options?: BulkProfileOptions;
  };
  if (!Array.isArray(items) || !items.length) {
    res.status(400).json({ error: "items array required" });
    return;
  }
  try {
    const result = await startBulkProfile(items, options);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result.batch);
  } catch (err) {
    internalError(res, err, "bulk-profile");
  }
});

// POST /bulk-profile/generate -- AI-written profiles, cleaned to what Telegram accepts
router.post("/bulk-profile/generate", bulkMgmtGuard, async (req, res) => {
  const { count, hint, includeAbout } = req.body as {
    count?: number;
    hint?: string;
    includeAbout?: boolean;
  };
  const wanted = Number(count);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > 200) {
    res.status(400).json({ error: "count must be between 1 and 200" });
    return;
  }
  try {
    const { profiles } = await generateProfiles(
      wanted,
      hint?.trim() || undefined,
      includeAbout !== false,
    );
    res.json({ profiles });
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "Profile generation failed" });
  }
});

// GET /bulk-profile/status -- current batch progress (null if none has run)
router.get("/bulk-profile/status", bulkMgmtGuard, (_req, res) => {
  res.json(getBulkProfileStatus());
});

// POST /bulk-profile/cancel -- stop the running batch after the current step
router.post("/bulk-profile/cancel", bulkMgmtGuard, (_req, res) => {
  res.json({ cancelled: cancelBulkProfile() });
});

// POST /gmail/test -- check Gmail IMAP login works (for bulk login-email change)
router.post("/gmail/test", bulkMgmtGuard, async (req, res) => {
  const { gmail, appPassword } = req.body as {
    gmail?: string;
    appPassword?: string;
  };
  if (!gmail || !gmail.includes("@") || !appPassword) {
    res.status(400).json({ error: "gmail and appPassword are required" });
    return;
  }
  const result = await testGmailImap(gmail.trim(), appPassword);
  res.json(result);
});

// PUT /reorder -- update sort_order for multiple accounts at once
router.put("/reorder", async (req, res) => {
  const { items } = req.body as {
    items?: Array<{ id: number; sortOrder: number }>;
  };
  if (!Array.isArray(items)) {
    res.status(400).json({ error: "items array required" });
    return;
  }
  try {
    // A transaction in SQLite, sequential writes now: Mongo transactions need a replica set,
    // so a failure part-way through leaves earlier accounts reordered. The caller re-sends
    // the whole list, which makes a retry harmless.
    for (const { id, sortOrder } of items) {
      await updateAccount(id, { sort_order: sortOrder });
    }
    res.json({ ok: true });
  } catch (err) {
    internalError(res, err, "reorder");
  }
});

// PUT /bulk-notes -- update notes for multiple accounts at once
router.put("/bulk-notes", async (req, res) => {
  const { ids, notes } = req.body as { ids?: number[]; notes?: string | null };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: "ids array required" });
    return;
  }
  try {
    // Sequential rather than transactional (see /reorder): a partial failure leaves some
    // accounts with the new notes.
    const newNotes = notes || null;
    for (const id of ids) await updateAccount(id, { notes: newNotes });
    res.json({ ok: true });
  } catch (err) {
    internalError(res, err, "bulk-notes");
  }
});

// PUT /bulk-rename -- set the Bemby name for multiple accounts at once. Each
// item carries its own pre-computed name; blank names are skipped.
router.put("/bulk-rename", async (req, res) => {
  const { items } = req.body as {
    items?: Array<{ id: number; name: string }>;
  };
  if (!Array.isArray(items) || !items.length) {
    res.status(400).json({ error: "items array required" });
    return;
  }
  try {
    // Sequential rather than transactional (see /reorder): a partial failure leaves some
    // accounts renamed.
    for (const { id, name } of items) {
      const trimmed = String(name ?? "").trim();
      if (trimmed) await updateAccount(id, { name: trimmed });
    }
    res.json({ ok: true });
  } catch (err) {
    internalError(res, err, "bulk-rename");
  }
});

type AccountImportItem = {
  name?: string;
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  sessionString?: string | null;
  authStatus?: string;
  proxyId?: string | null;
  appClientId?: string | null;
  disabled?: boolean;
  // Passkey secret and generic flags travel inline with the account. `passkey` is the
  // current shape; `passkeys` (array) from interim builds is still tolerated on import.
  passkey?: unknown;
  passkeys?: unknown;
  additionalAttributes?: Record<string, unknown> | null;
};

// POST /export -- export selected (or all) accounts with sensitive fields
router.post("/export", async (req, res) => {
  const { ids, secret } = req.body as { ids?: number[]; secret?: string };
  try {
    const filter: Filter<AccountDoc> =
      Array.isArray(ids) && ids.length ? { _id: { $in: ids } } : {};
    const docs = await accountsCol().find(filter).sort({ _id: 1 }).toArray();
    const rows: AccountRow[] = docs.map(toAccountRow);
    // A backup carries the credentials in the clear inside its own encrypted envelope, so the
    // at-rest key is never needed to restore one somewhere else
    rows.forEach(decryptAccountRow);
    const accounts = await Promise.all(
      rows.map(async (a) => ({
        name: a.name,
        phoneNumber: a.phone_number,
        apiId: a.api_id,
        apiHash: a.api_hash,
        sessionString: a.session_string,
        authStatus: a.auth_status,
        proxyId: a.proxy_id ?? null,
        appClientId: a.app_client_id ?? null,
        disabled: Boolean(a.disabled),
        // Passkey secret (incl. private key + home DC) so the account can still log in
        // after import, even when force-reauth clears the session string.
        passkey: parseStoredPasskey(a.passkey),
        // Generic per-account flags bag.
        additionalAttributes: await parseAttributes(a.additional_attributes),
      })),
    );
    const payload = {
      version: "1",
      exportedAt: new Date().toISOString(),
      accounts,
    };
    const hasSecrets = payload.accounts.some(
      (a) =>
        a.sessionString != null || a.apiHash || a.passkey?.privateKeyPem,
    );
    if (hasSecrets && !secret) {
      res.status(400).json({
        error: 'This export contains session strings or API credentials. Provide an encryption secret.',
        code: 'SECRET_REQUIRED',
      });
      return;
    }

    if (secret) {
      res.json(encryptPayload(JSON.stringify(payload), secret));
    } else {
      res.json(payload);
    }
  } catch (err) {
    internalError(res, err, "export");
  }
});

// POST /import -- import accounts; skips existing by phone number
router.post("/import", async (req, res) => {
  let {
    data,
    secret,
    forceReauth = true,
  } = req.body as {
    data:
      { version?: string; accounts?: AccountImportItem[] } | EncryptedEnvelope;
    secret?: string;
    forceReauth?: boolean;
  };

  if (data && (data as EncryptedEnvelope).encrypted === true) {
    if (!secret) {
      res
        .status(400)
        .json({
          error:
            "This backup is encrypted. Please provide the secret to decrypt it.",
        });
      return;
    }
    try {
      data = JSON.parse(decryptPayload(data as EncryptedEnvelope, secret));
    } catch {
      res
        .status(400)
        .json({
          error: "Incorrect secret or corrupted backup file",
          code: "WRONG_SECRET",
        });
      return;
    }
  }

  const payload = data as { version?: string; accounts?: AccountImportItem[] };
  const items = payload?.accounts;
  if (!Array.isArray(items)) {
    res.status(400).json({ error: "accounts array required" });
    return;
  }
  let imported = 0;
  let skipped = 0;
  try {
    const defaults = await getDefaultTgApiCredentials();
    // Each account was inserted inside one SQLite transaction, so a failure anywhere
    // imported nothing at all. Mongo transactions need a replica set, so these are written
    // one after another: a failure part-way through now leaves the accounts imported so far
    // in place, and re-running the import skips them by phone number.
    for (const a of items) {
      if (!a.phoneNumber || ((!a.apiId || !a.apiHash) && !defaults)) {
        skipped++;
        continue;
      }
      if (await findAccountByPhone(a.phoneNumber)) {
        skipped++;
        continue;
      }
      const newId = await createAccount({
        name: a.name || a.phoneNumber,
        phone_number: a.phoneNumber,
        api_id: a.apiId ? Number(a.apiId) : null,
        api_hash: encryptSecret(a.apiHash),
        session_string: encryptSecret(forceReauth ? null : (a.sessionString ?? null)),
        auth_status: forceReauth ? "unauthenticated" : (a.authStatus ?? "unauthenticated"),
        proxy_id: a.proxyId ?? null,
        app_client_id: a.appClientId ?? null,
        disabled: a.disabled ? 1 : 0,
      });
      // Restore the passkey secret under the newly assigned account id. The passkey (with
      // its home DC) is what lets the account log in after a force-reauth import.
      const pk = importedPasskeyFor(a);
      if (pk) await savePasskeySecret({ ...pk, accountId: newId });
      // Restore the generic attributes bag.
      const attrs = foldImportedAttributes(a);
      if (attrs) await writeAttributes(newId, attrs);
      imported++;
    }
    res.json({ imported, skipped });
  } catch (err) {
    internalError(res, err, "import");
  }
});

router.put("/:id", async (req, res) => {
  const {
    name,
    phoneNumber,
    apiId,
    apiHash,
    proxyId,
    disabled,
    appClientId,
    notes,
  } = req.body as Record<string, string | null | boolean>;
  try {
    const existing = await loadAccount(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // undefined = not in payload (keep existing), null/'' = clear
    const newProxyId =
      proxyId !== undefined ? (proxyId as string) || null : (existing.proxy_id ?? null);
    const newDisabled =
      disabled !== undefined ? (disabled ? 1 : 0) : Number(existing.disabled ?? 0);
    const newAppClientId =
      appClientId !== undefined
        ? (appClientId as string) || null
        : (existing.app_client_id ?? null);
    const newNotes = notes !== undefined ? (notes as string) || null : (existing.notes ?? null);

    await updateAccount(existing.id, {
      name: (name as string | undefined) ?? existing.name,
      phone_number: (phoneNumber as string | undefined) ?? existing.phone_number,
      api_id: apiId !== undefined ? Number(apiId) : existing.api_id,
      api_hash: encryptSecret(
        (apiHash as string | null | undefined) ?? existing.api_hash,
      ),
      proxy_id: newProxyId,
      disabled: newDisabled,
      app_client_id: newAppClientId,
      notes: newNotes,
    });

    const row = (await loadAccount(existing.id)) as AccountRow;
    res.json(await toJson(row));
  } catch (err) {
    internalError(res, err, "update");
  }
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    // checkin/custom jobs can't run without their linked account; deleting it here
    // would silently drop the job out of the scheduler (account_id -> NULL via FK)
    const linkedJobs = (await col<JobDoc>("jobs")
      .find({
        account_id: id,
        ...NOT_RETIRED,
        job_type: { $in: ["checkin", "custom"] },
      })
      .toArray()) as Array<{ name: string }>;
    if (linkedJobs.length) {
      res.status(400).json({
        error: `Cannot delete account: ${linkedJobs.length} job(s) still depend on it (${linkedJobs.map((j) => j.name).join(", ")}). Reassign or delete those jobs first.`,
      });
      return;
    }
    await deleteAccount(id);
    refreshScheduler();
    res.status(204).send();
  } catch (err) {
    internalError(res, err, "delete");
  }
});

// ── TG account status check ─────────────────────────────────────────────────

router.post("/:id/check-status", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }

  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const status = await checkAccountStatus(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    if (statusNeedsReauth(status)) await markSessionExpired(account.id);
    await saveTgMeta(account.id, status.firstName, status.lastName, status.username);
    res.json(status);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account.id);
    internalError(res, err, 'check-status');
  }
});

// POST /:id/refresh-tg-meta -- fetch TG display name and persist it; returns { tgDisplayName, tgUsername }
router.post("/:id/refresh-tg-meta", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const status = await checkAccountStatus(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    if (statusNeedsReauth(status)) await markSessionExpired(account.id);
    await saveTgMeta(account.id, status.firstName, status.lastName, status.username);
    const displayName = [status.firstName, status.lastName]
      .filter(Boolean)
      .join(" ");
    res.json({
      tgDisplayName: displayName || null,
      tgUsername: status.username ?? null,
    });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account.id);
    internalError(res, err, 'refresh-tg-meta');
  }
});

// POST /check-enabled-sessions -- check all enabled+authenticated accounts and mark expired ones
router.post("/check-enabled-sessions", async (req, res) => {
  const docs = await accountsCol()
    .find({
      // disabled = 0, where a document predating the column omits it entirely
      disabled: coalesceZero(0) as AccountDoc["disabled"],
      auth_status: "authenticated",
    })
    .toArray();
  const rows = docs.map(toAccountRow);
  rows.forEach(decryptAccountRow);

  const results = await Promise.allSettled(
    rows.map(async (account) => {
      if (!account.session_string) return { id: account.id, expired: true };
      try {
        const { apiId, apiHash } = await resolveApiCredentials(account);
        const proxyUrl = await resolveProxyUrl(account.proxy_id);
        const proxy = parseTgProxy(proxyUrl);
        const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
        const status = await checkAccountStatus(
          apiId,
          apiHash,
          account.session_string,
          proxy,
          deviceParams,
        );
        if (statusNeedsReauth(status)) {
          await markSessionExpired(account.id);
          return { id: account.id, expired: true };
        }
        return { id: account.id, expired: false };
      } catch (err: any) {
        if (isAuthError(err?.message ?? "")) {
          await markSessionExpired(account.id);
          return { id: account.id, expired: true };
        }
        return { id: account.id, expired: false };
      }
    }),
  );

  const expired = results
    .filter(
      (r) =>
        r.status === "fulfilled" &&
        (r as PromiseFulfilledResult<any>).value.expired,
    )
    .map((r) => (r as PromiseFulfilledResult<any>).value.id);

  res.json({ checked: rows.length, expired });
});

// POST /:id/check-spam -- send /start to @SpamBot and return the parsed spam status
router.post("/:id/check-spam", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }

  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const result = await checkSpamStatus(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    // Persist the restriction for the account-list badge: store the status when the
    // account is restricted, clear it when confirmed free, leave it on an unknown result.
    if (result.spamStatus === "free") {
      await patchAttributes(account.id, { restriction: undefined });
    } else if (result.spamStatus !== "unknown") {
      await patchAttributes(account.id, { restriction: result.spamStatus });
    }
    res.json(result);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account.id);
    internalError(res, err, 'check-spam');
  }
});

// POST /:id/fetch-attributes -- refresh all TG meta and extra attributes for one
// account (display name/username, hasEmail, hasPasskey). Deliberately excludes the
// spam check. Each step runs independently so one failure does not block the rest;
// per-step failures are returned as warnings.
router.post("/:id/fetch-attributes", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!requireAuth(account, res)) return;

  let apiId!: number;
  let apiHash!: string;
  let proxy!: ReturnType<typeof parseTgProxy>;
  let deviceParams!: Awaited<ReturnType<typeof resolveAppClientParams>>;
  try {
    ({ apiId, apiHash } = await resolveApiCredentials(account));
    proxy = parseTgProxy(await resolveProxyUrl(account.proxy_id));
    deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
  } catch (err: any) {
    internalError(res, err, "fetch-attributes");
    return;
  }

  const warnings: string[] = [];
  let authExpired = false;
  // Skip remaining steps once the session is known dead; they would only fail too.
  const runStep = async (label: string, fn: () => Promise<void>) => {
    if (authExpired) return;
    try {
      await fn();
    } catch (err: any) {
      if (isAuthError(err?.message ?? "")) {
        await markSessionExpired(account.id);
        authExpired = true;
      }
      warnings.push(
        `${label}: ${err?.errorMessage ?? err?.message ?? "failed"}`,
      );
    }
  };

  await runStep("status", async () => {
    const status = await checkAccountStatus(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    if (statusNeedsReauth(status)) {
      await markSessionExpired(account.id);
      authExpired = true;
    }
    await saveTgMeta(account.id, status.firstName, status.lastName, status.username);
  });
  await runStep("password-info", async () => {
    const info = await getPasswordInfo(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    await patchAttributes(account.id, {
      hasEmail: info.loginEmailPattern ? true : undefined,
    });
  });
  await runStep("passkeys", async () => {
    const passkeys = await getPasskeys(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    await pruneAccountPasskeySecrets(
      account.id,
      passkeys.map((p) => p.id),
    );
    await patchAttributes(account.id, { hasPasskey: passkeys.length > 0 });
  });

  const row = (await loadAccount(account.id)) as AccountRow;
  res.json({ account: await toJson(row), warnings, authExpired });
});

// POST /:id/update-2fa -- set, change, or remove the account's 2FA password
router.post("/:id/update-2fa", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  const { currentPassword, newPassword, hint } = req.body as {
    currentPassword?: string;
    newPassword?: string;
    hint?: string;
  };
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    await updateTwoFa(
      apiId,
      apiHash,
      account.session_string,
      { currentPassword, newPassword, hint },
      proxy,
      deviceParams,
    );
    res.json({ success: true });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account.id);
    internalError(res, err, 'update-2fa');
  }
});

// GET /:id/profile -- fetch the account's own Telegram profile (first/last name + bio)
router.get("/:id/profile", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const profile = await getProfile(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    res.json(profile);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account.id);
    internalError(res, err, "profile");
  }
});

// POST /:id/update-profile -- update the account's own Telegram profile
router.post("/:id/update-profile", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  const { firstName, lastName, about } = req.body as {
    firstName?: string;
    lastName?: string;
    about?: string;
  };
  if (!firstName || !firstName.trim()) {
    res.status(400).json({ error: "firstName is required" });
    return;
  }
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const profile = await updateProfile(
      apiId,
      apiHash,
      account.session_string,
      { firstName, lastName, about },
      proxy,
      deviceParams,
    );
    // Keep the cached display name in sync with the new profile
    await saveTgMeta(
      account.id,
      profile.firstName,
      profile.lastName,
      account.tg_username ?? undefined,
    );
    const tgDisplayName =
      [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
    res.json({ ...profile, tgDisplayName });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account.id);
    internalError(res, err, "update-profile");
  }
});

// GET /:id/sessions -- list all active Telegram sessions for this account
router.get("/:id/sessions", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const sessions = await getSessions(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    res.json(sessions);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account.id);
    internalError(res, err, 'sessions');
  }
});

// POST /:id/terminate-session -- revoke a specific session by hash
router.post("/:id/terminate-session", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  const { hash } = req.body as { hash?: string };
  if (!hash) {
    res.status(400).json({ error: "hash required" });
    return;
  }
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    await terminateSession(
      apiId,
      apiHash,
      account.session_string,
      hash,
      proxy,
      deviceParams,
    );
    res.json({ success: true });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account.id);
    internalError(res, err, 'terminate-session');
  }
});

// POST /:id/terminate-other-sessions -- revoke all sessions except the current one
router.post("/:id/terminate-other-sessions", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    await terminateOtherSessions(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    res.json({ success: true });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account.id);
    internalError(res, err, 'terminate-other-sessions');
  }
});

// POST /:id/force-reauth -- clear session and reset auth status so the account can be re-authenticated
router.post("/:id/force-reauth", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    // Capture the account's DC onto its stored passkeys before we drop the session,
    // so a later passkey login can still reach the right data centre.
    if (account.session_string) {
      const dc = getSessionDc(account.session_string);
      if (dc) await setAccountPasskeyDc(account.id, dc);
    }
    await updateAccount(account.id, {
      session_string: null,
      auth_status: "unauthenticated",
    });
    await markSessionExpired(account.id);
    const row = (await loadAccount(account.id)) as AccountRow;
    res.json(await toJson(row));
  } catch (err) {
    internalError(res, err, "force-reauth");
  }
});

// ── Login email management ────────────────────────────────────────────────────

function requireAuth(account: AccountRow | undefined, res: any): account is AccountRow & { session_string: string } {
  if (!account) { res.status(404).json({ error: "Not found" }); return false; }
  if (!account.session_string) { res.status(400).json({ error: "Account not authenticated" }); return false; }
  return true;
}

// GET /:id/password-info -- returns 2FA status and masked login email pattern (no password needed)
router.get("/:id/password-info", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!requireAuth(account, res)) return;
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const info = await getPasswordInfo(apiId, apiHash, account.session_string, proxy, deviceParams);
    // Store hasEmail only when a login email is found; drop the flag otherwise.
    await patchAttributes(account.id, { hasEmail: info.loginEmailPattern ? true : undefined });
    res.json(info);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account!.id);
    internalError(res, err, "password-info");
  }
});

// POST /:id/login-email/send-code -- send a verification code to a new login email
// Telegram has no API to remove the login email from an authorised session; it can only be replaced.
router.post("/:id/login-email/send-code", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!requireAuth(account, res)) return;
  const { email } = req.body as { email?: string };
  if (!email) { res.status(400).json({ error: "email required" }); return; }
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const result = await sendLoginEmailCode(apiId, apiHash, account.session_string, email, proxy, deviceParams);
    res.json(result);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "login-email/send-code")) return;
    internalError(res, err, "login-email/send-code");
  }
});

// POST /:id/login-email/auto -- set a Gmail plus-address login email and read
// the confirmation code back over IMAP. Gated by BULK_ACCOUNT_MANAGEMENT.
router.post("/:id/login-email/auto", bulkMgmtGuard, async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!requireAuth(account, res)) return;
  const { gmail, appPassword, tag } = req.body as {
    gmail?: string;
    appPassword?: string;
    tag?: string;
  };
  if (!gmail || !gmail.includes("@") || !appPassword) {
    res.status(400).json({ error: "gmail and appPassword are required" });
    return;
  }
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxy = parseTgProxy(await resolveProxyUrl(account.proxy_id));
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const result = await changeLoginEmailViaGmail({
      apiId,
      apiHash,
      sessionString: account.session_string,
      phoneNumber: account.phone_number,
      accountId: account.id,
      proxy,
      deviceParams,
      gmail: gmail.trim(),
      appPassword,
      tag: (tag ?? "").trim(),
    });
    res.json(result);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "login-email/auto")) return;
    internalError(res, err, "login-email/auto");
  }
});

// POST /:id/login-email/verify -- confirm the new login email with the emailed code
router.post("/:id/login-email/verify", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!requireAuth(account, res)) return;
  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ error: "code required" }); return; }
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const result = await verifyLoginEmail(apiId, apiHash, account.session_string, code, proxy, deviceParams);
    res.json(result);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "login-email/verify")) return;
    internalError(res, err, "login-email/verify");
  }
});

// ── Passkeys ──────────────────────────────────────────────────────────────────

// GET /:id/passkeys -- list the account's passkeys
router.get("/:id/passkeys", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!requireAuth(account, res)) return;
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxy = parseTgProxy(await resolveProxyUrl(account.proxy_id));
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const passkeys = await getPasskeys(apiId, apiHash, account.session_string, proxy, deviceParams);
    // Telegram is authoritative: drop stored keys for passkeys that no longer
    // exist there (e.g. removed when the 2FA password was changed), so storedIds
    // stay accurate.
    await pruneAccountPasskeySecrets(account.id, passkeys.map((p) => p.id));
    // Record whether the account has ANY passkey (any device/origin) for the list flag.
    await patchAttributes(account.id, { hasPasskey: passkeys.length > 0 });
    res.json({ passkeys, storedIds: await storedPasskeyIdsForAccount(account.id) });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "passkeys/list")) return;
    internalError(res, err, "passkeys/list");
  }
});

// POST /:id/passkeys -- register a new passkey (experimental; WebAuthn ceremony run server-side)
router.post("/:id/passkeys", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!requireAuth(account, res)) return;
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxy = parseTgProxy(await resolveProxyUrl(account.proxy_id));
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const origin = typeof req.body?.origin === "string" ? req.body.origin : undefined;
    const result = await registerPasskey(
      apiId,
      apiHash,
      account.session_string,
      origin,
      proxy,
      deviceParams,
    );
    // Persist the private key so the passkey can later be used/verified for login.
    const dc = getSessionDc(account.session_string) ?? {};
    await savePasskeySecret({
      accountId: account.id,
      telegramPasskeyId: result.passkey.id,
      credentialId: result.credentialId,
      privateKeyPem: result.privateKeyPem,
      rpId: result.rpId,
      userHandle: result.userHandle,
      createdDate: result.passkey.date,
      ...dc,
    });
    // The account now has a passkey (this one, created by Bemby).
    await patchAttributes(account.id, { hasPasskey: true });
    res.json({ passkey: result.passkey });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "passkeys/register")) return;
    internalError(res, err, "passkeys/register");
  }
});

// POST /:id/passkeys/:passkeyId/verify -- prove the passkey works via a real login
router.post("/:id/passkeys/:passkeyId/verify", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!requireAuth(account, res)) return;
  try {
    const secret = await getPasskeySecret(req.params.passkeyId);
    if (!secret || secret.accountId !== account.id) {
      res.status(404).json({ error: "no stored key for this passkey" });
      return;
    }
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxy = parseTgProxy(await resolveProxyUrl(account.proxy_id));
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const origin = typeof req.body?.origin === "string" ? req.body.origin : undefined;
    const result = await verifyPasskeyLogin(
      apiId,
      apiHash,
      account.session_string,
      secret,
      origin,
      proxy,
      deviceParams,
    );
    res.json(result);
  } catch (err: any) {
    if (rpcBadRequest(res, err, "passkeys/verify")) return;
    internalError(res, err, "passkeys/verify");
  }
});

// DELETE /:id/passkeys/:passkeyId -- revoke a passkey
router.delete("/:id/passkeys/:passkeyId", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!requireAuth(account, res)) return;
  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxy = parseTgProxy(await resolveProxyUrl(account.proxy_id));
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);
    const ok = await deletePasskey(
      apiId,
      apiHash,
      account.session_string,
      req.params.passkeyId,
      proxy,
      deviceParams,
    );
    if (ok) await deletePasskeySecret(req.params.passkeyId);
    res.json({ ok });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) await markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "passkeys/delete")) return;
    internalError(res, err, "passkeys/delete");
  }
});

// ── Telegram auth flow ──────────────────────────────────────────────────────

router.post("/:id/auth/request", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  try {
    const { apiId, apiHash } = await resolveApiCredentials(account);
    const proxyUrl = await resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = await resolveAppClientParams(account.id, account.app_client_id);

    // Prefer passkey login when we hold a usable (DC-known) stored passkey; fall
    // back to the code flow if none exist or the passkey is rejected.
    const secret = (await accountPasskeySecrets(account.id)).find(
      (s) => s.dcId != null,
    );
    if (secret) {
      try {
        const result = await startPasskeyLogin(
          account.id,
          apiId,
          apiHash,
          secret,
          undefined,
          proxy,
        );
        if (result.needsPassword) {
          await updateAccount(account.id, { auth_status: "pending_2fa" });
          res.json({ method: "passkey", step: "2fa" });
        } else {
          await updateAccount(account.id, {
            auth_status: "authenticated",
            session_string: encryptSecret(result.session),
          });
          res.json({ method: "passkey", step: "done" });
        }
        return;
      } catch (err: any) {
        // Passkey unusable -- fall through to the code flow below.
        console.warn(
          `[accounts] passkey login failed for ${account.id}, falling back to code:`,
          err?.errorMessage ?? err?.message ?? err,
        );
      }
    }

    const { isCodeViaApp } = await requestCode(
      account.id,
      apiId,
      apiHash,
      account.phone_number,
      proxy,
      deviceParams,
    );
    await updateAccount(account.id, { auth_status: "pending_code" });
    res.json({ method: "code", message: "Verification code sent", isCodeViaApp });
  } catch (err: any) {
    if (rpcBadRequest(res, err, 'auth/request')) return;
    internalError(res, err, 'auth/request');
  }
});

router.post("/:id/auth/resend", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    await resendCodeAsSms(account.id);
    res.json({ ok: true });
  } catch (err: any) {
    if (rpcBadRequest(res, err, 'auth/resend')) return;
    internalError(res, err, 'auth/resend');
  }
});

router.post("/:id/auth/verify", async (req, res) => {
  const account = await loadAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const { code, password } = req.body as { code?: string; password?: string };

  try {
    if (account.auth_status === "pending_code" && code) {
      const result = await submitCode(account.id, code);
      if (result.needsPassword) {
        await updateAccount(account.id, { auth_status: "pending_2fa" });
        res.json({ step: "2fa" });
      } else {
        await updateAccount(account.id, {
          auth_status: "authenticated",
          session_string: encryptSecret(result.session),
        });
        res.json({ step: "done" });
      }
    } else if (account.auth_status === "pending_2fa" && password) {
      const session = await submitPassword(account.id, password);
      await updateAccount(account.id, {
        auth_status: "authenticated",
        session_string: encryptSecret(session),
      });
      res.json({ step: "done" });
    } else {
      res
        .status(400)
        .json({ error: "Invalid auth state or missing credentials" });
    }
  } catch (err: any) {
    if (rpcBadRequest(res, err, 'auth/verify')) return;
    internalError(res, err, 'auth/verify');
  }
});

export default router;
