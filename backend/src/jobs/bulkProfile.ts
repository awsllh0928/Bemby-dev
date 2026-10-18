import crypto from "crypto";
import { getDefaultTgApiCredentials } from "../db/database";
import { getAccount, updateAccount } from "../db/repos/accounts";
import { getSetting } from "../db/repos/settings";
import { decryptAccountRow } from "../db/secretColumns";
import { updateProfile } from "../auth/tgAuth";
import { parseTgProxy } from "./runner";
import { resolveAppClientParams } from "../tg/appClient";
import { isAuthError, markSessionExpired } from "../tg/liveClient";

// Bulk-updates the Telegram profile (first name, last name, bio/about) of
// already-authenticated accounts. Accounts are processed one at a time with a
// gap between them to stay under Telegram's rate limits; failed accounts are
// retried a few times. Runs as a background batch that survives page reloads,
// mirroring the bulk-add flow.

export type BulkProfileItemStatus =
  | "pending"
  | "updating"
  | "waiting"
  | "retrying"
  | "done"
  | "failed";

export type BulkProfileItem = {
  index: number;
  accountId: number;
  accountName: string;
  firstName: string;
  lastName: string;
  about: string;
  attempts: number;
  status: BulkProfileItemStatus;
  message: string;
  error: string | null;
};

export type BulkProfileBatch = {
  id: string;
  createdAt: string;
  running: boolean;
  cancelled: boolean;
  total: number;
  items: BulkProfileItem[];
};

// One account's target profile, as supplied by the client.
export type BulkProfileEntry = {
  accountId: number;
  firstName: string;
  lastName?: string;
  about?: string;
};

export type BulkProfileOptions = {
  /** Pause between accounts, in seconds (default 3). */
  gapSeconds?: number;
  /** How many times to retry an account after a failed update (default 1). */
  maxRetries?: number;
  /** Cooldown before a failed account is retried, in seconds (default 60). */
  retryDelaySeconds?: number;
};

type BulkProfileConfig = {
  betweenAccountsMs: number;
  maxRetries: number;
  retryDelayMs: number;
};

const DEFAULT_GAP_SECONDS = 3;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_SECONDS = 60;

function resolveConfig(opts?: BulkProfileOptions): BulkProfileConfig {
  const gap = Number(opts?.gapSeconds);
  const retries = Number(opts?.maxRetries);
  const retryDelay = Number(opts?.retryDelaySeconds);
  return {
    betweenAccountsMs:
      Number.isFinite(gap) && gap >= 0
        ? gap * 1000
        : DEFAULT_GAP_SECONDS * 1000,
    maxRetries:
      Number.isFinite(retries) && retries >= 0
        ? Math.floor(retries)
        : DEFAULT_MAX_RETRIES,
    retryDelayMs:
      Number.isFinite(retryDelay) && retryDelay >= 0
        ? retryDelay * 1000
        : DEFAULT_RETRY_DELAY_SECONDS * 1000,
  };
}

let current: BulkProfileBatch | null = null;

export function getBulkProfileStatus(): BulkProfileBatch | null {
  return current;
}

export function cancelBulkProfile(): boolean {
  if (!current || !current.running) return false;
  current.cancelled = true;
  return true;
}

async function resolveProxyUrl(proxyId: string | null): Promise<string | undefined> {
  if (!proxyId) return undefined;
  try {
    const value = await getSetting("proxies");
    const list = value
      ? (JSON.parse(value) as Array<{ id: string; url: string }>)
      : [];
    return list.find((p) => p.id === proxyId)?.url;
  } catch {
    return undefined;
  }
}

// Abortable sleep -- resolves early when the batch is cancelled.
function sleep(ms: number, batch: BulkProfileBatch): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (batch.cancelled || Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(1000, ms));
    };
    tick();
  });
}

async function updateOne(item: BulkProfileItem): Promise<void> {
  const account = await getAccount(item.accountId);
  if (!account) throw new Error("Account not found");
  decryptAccountRow(account);
  if (account.auth_status !== "authenticated" || !account.session_string) {
    throw new Error("Account is not authenticated");
  }

  const own =
    account.api_id && account.api_hash
      ? { apiId: account.api_id, apiHash: account.api_hash }
      : null;
  const creds = own ?? (await getDefaultTgApiCredentials());
  if (!creds) {
    throw new Error(
      "No API credentials -- configure global defaults in Settings",
    );
  }

  const proxy = parseTgProxy(await resolveProxyUrl(account.proxy_id ?? null));
  const deviceParams = await resolveAppClientParams(
    account._id,
    account.app_client_id,
  );

  const profile = await updateProfile(
    creds.apiId,
    creds.apiHash,
    account.session_string,
    { firstName: item.firstName, lastName: item.lastName, about: item.about },
    proxy,
    deviceParams,
  );

  // Keep the cached display name in sync with the new profile.
  const displayName =
    [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
  await updateAccount(account._id, { tg_display_name: displayName });
}

type QueueEntry = { item: BulkProfileItem; readyAt: number };

async function runBatch(
  batch: BulkProfileBatch,
  config: BulkProfileConfig,
): Promise<void> {
  try {
    const queue: QueueEntry[] = batch.items.map((item) => ({
      item,
      readyAt: 0,
    }));
    const totalAttempts = config.maxRetries + 1;
    let processedAny = false;

    while (queue.length && !batch.cancelled) {
      const entry = queue.shift()!;
      const { item } = entry;

      const cooldownMs = entry.readyAt - Date.now();
      if (cooldownMs > 0) {
        item.status = "retrying";
        item.message = `Retrying in ${Math.round(cooldownMs / 1000)}s (attempt ${item.attempts + 1}/${totalAttempts})`;
        await sleep(cooldownMs, batch);
        if (batch.cancelled) break;
      }

      // The gap spaces successive Telegram calls; applied before every update
      // except the first.
      if (processedAny) {
        item.status = "waiting";
        item.message = `Waiting ${Math.round(config.betweenAccountsMs / 1000)}s before updating`;
        await sleep(config.betweenAccountsMs, batch);
        if (batch.cancelled) break;
      }

      item.attempts++;
      item.status = "updating";
      item.message = "Updating profile";
      try {
        await updateOne(item);
        item.status = "done";
        item.message = "Profile updated";
        item.error = null;
      } catch (err: any) {
        const reason = err?.message ?? String(err);
        if (isAuthError(reason)) markSessionExpired(item.accountId);
        if (item.attempts <= config.maxRetries && !batch.cancelled) {
          entry.readyAt = Date.now() + config.retryDelayMs;
          item.status = "retrying";
          item.error = null;
          item.message = `Attempt ${item.attempts}/${totalAttempts} failed (${reason}) -- retrying in ${Math.round(config.retryDelayMs / 1000)}s`;
          queue.push(entry);
        } else {
          item.status = "failed";
          item.error = reason;
          item.message = `Failed after ${item.attempts} attempt(s): ${reason}`;
        }
      }
      processedAny = true;
    }
  } finally {
    batch.running = false;
  }
}

export type StartBulkProfileResult =
  | { ok: true; batch: BulkProfileBatch }
  | { ok: false; error: string };

export async function startBulkProfile(
  entries: BulkProfileEntry[],
  options?: BulkProfileOptions,
): Promise<StartBulkProfileResult> {
  if (current?.running) {
    return { ok: false, error: "A bulk-rename batch is already running" };
  }
  if (!Array.isArray(entries) || !entries.length) {
    return { ok: false, error: "No accounts provided" };
  }

  const items: BulkProfileItem[] = [];
  for (const [index, entry] of entries.entries()) {
    const accountId = Number(entry?.accountId);
    const firstName = String(entry?.firstName ?? "").trim();
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return { ok: false, error: `Invalid account id on row ${index + 1}` };
    }
    if (!firstName) {
      return { ok: false, error: `First name is required on row ${index + 1}` };
    }
    const account = await getAccount(accountId);
    if (!account) {
      return { ok: false, error: `Account ${accountId} not found` };
    }
    items.push({
      index,
      accountId,
      accountName: account.name,
      firstName,
      lastName: String(entry?.lastName ?? "").trim(),
      about: String(entry?.about ?? "").trim(),
      attempts: 0,
      status: "pending",
      message: "",
      error: null,
    });
  }

  const config = resolveConfig(options);
  const batch: BulkProfileBatch = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    running: true,
    cancelled: false,
    total: items.length,
    items,
  };
  current = batch;
  void runBatch(batch, config);
  return { ok: true, batch };
}
