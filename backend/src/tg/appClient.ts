import { getSetting, setSetting } from "../db/repos/settings";
import { col } from "../db/collection";
import type { AccountDoc } from "../db/types";
import { expandCommand } from "../jobs/checkin";
import type { TgAppClient } from "../types";
import type { TgDeviceParams } from "../auth/tgAuth";

// Per-account map of the randomly-assigned app client, keyed by account id.
// Kept in the settings table so a random pick stays stable for an account.
const ASSIGNMENTS_KEY = "tg_client_assignments";

// Per-account cache of the expanded deviceModel string. Persisting it keeps
// random tokens (e.g. {word:4}) stable across connects; we only re-expand when
// the source template or the account context changes (see `sig`).
const DEVICE_NAMES_KEY = "tg_client_device_names";

type CachedDeviceName = { sig: string; deviceModel: string };

async function readAppClients(): Promise<TgAppClient[]> {
  try {
    const value = await getSetting("tg_app_clients");
    if (!value) return [];
    return JSON.parse(value) as TgAppClient[];
  } catch {
    return [];
  }
}

async function readAssignments(): Promise<Record<string, string>> {
  try {
    const value = await getSetting(ASSIGNMENTS_KEY);
    if (!value) return {};
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return {};
  }
}

async function saveAssignment(accountId: number, clientId: string): Promise<void> {
  const map = await readAssignments();
  map[String(accountId)] = clientId;
  await setSetting(ASSIGNMENTS_KEY, JSON.stringify(map));
}

async function readDeviceNames(): Promise<Record<string, CachedDeviceName>> {
  try {
    const value = await getSetting(DEVICE_NAMES_KEY);
    if (!value) return {};
    return JSON.parse(value) as Record<string, CachedDeviceName>;
  } catch {
    return {};
  }
}

async function saveDeviceName(
  accountId: number,
  entry: CachedDeviceName,
): Promise<void> {
  const map = await readDeviceNames();
  map[String(accountId)] = entry;
  await setSetting(DEVICE_NAMES_KEY, JSON.stringify(map));
}

/**
 * Resolve the deviceModel for an account, expanding template variables.
 * Supported tokens: {name} (Bemby name), {tgName} (Telegram display name),
 * {tgUsername}, {id}, plus the random tokens from expandCommand ({word:4} etc.).
 * The expanded value is persisted per account so random tokens stay stable;
 * it is only re-rolled when the template or account context changes.
 */
async function resolveDeviceModel(
  accountId: number,
  client: TgAppClient,
  persist = true,
): Promise<string> {
  const template = client.deviceModel;
  // Fast path: no variables to expand.
  if (!template.includes("{")) return template;

  // SELECT name, tg_display_name, tg_username FROM tg_accounts WHERE id = ?
  const acct = await col<AccountDoc>("tg_accounts").findOne(
    { _id: accountId },
    { projection: { name: 1, tg_display_name: 1, tg_username: 1 } },
  );

  const context: Record<string, string> = {
    name: acct?.name ?? "",
    tgName: acct?.tg_display_name ?? "",
    tgUsername: acct?.tg_username ?? "",
    id: String(accountId),
  };

  // Signature captures everything that should trigger a re-expansion.
  const sig = [
    client.id,
    template,
    context.name,
    context.tgName,
    context.tgUsername,
  ].join("|");

  const cached = (await readDeviceNames())[String(accountId)];
  if (cached && cached.sig === sig) return cached.deviceModel;

  const expanded = expandCommand(template, context);
  if (persist) await saveDeviceName(accountId, { sig, deviceModel: expanded });
  return expanded;
}

/**
 * Read-only preview of the device model an account would use for a given
 * (possibly hypothetical) client selection. Does not persist random tokens or
 * random-client assignments, so it is safe to call for UI previews.
 * Returns null when no clients are configured / resolvable.
 */
export async function previewDeviceModel(
  accountId: number,
  appClientId: string | null | undefined,
): Promise<string | null> {
  try {
    const list = await readAppClients();
    if (!list.length) return null;

    let client: TgAppClient | undefined;
    if (appClientId) {
      client = list.find((c) => c.id === appClientId);
    } else {
      const mode = await getSetting("tg_client_mode");
      if (mode === "random") {
        // Reuse an existing sticky pick if present; otherwise fall back to the
        // default as an illustrative preview (the real pick happens on connect).
        const assignedId = (await readAssignments())[String(accountId)];
        client =
          (assignedId && list.find((c) => c.id === assignedId)) ||
          list.find((c) => c.isDefault);
      } else {
        client = list.find((c) => c.isDefault);
      }
    }

    if (!client) return null;
    return await resolveDeviceModel(accountId, client, false);
  } catch {
    return null;
  }
}

async function toDeviceParams(
  accountId: number,
  c: TgAppClient,
): Promise<TgDeviceParams> {
  return {
    deviceModel: await resolveDeviceModel(accountId, c),
    systemVersion: c.systemVersion,
    appVersion: c.appVersion,
    langCode: c.langCode,
    langPack: c.langPack,
    systemLangCode: c.systemLangCode,
  };
}

/**
 * Resolve the Telegram device params for an account.
 * - Explicit appClientId: use that client.
 * - No client + random mode: use a per-account sticky random pick that is
 *   persisted, so the same device is reused for auth, jobs and the live client.
 *   Only re-rolls if the previously assigned client no longer exists.
 * - Otherwise: use the default client.
 */
export async function resolveAppClientParams(
  accountId: number,
  appClientId: string | null | undefined,
): Promise<TgDeviceParams | undefined> {
  try {
    const list = await readAppClients();
    if (!list.length) return undefined;

    if (appClientId) {
      const client = list.find((c) => c.id === appClientId);
      return client ? await toDeviceParams(accountId, client) : undefined;
    }

    const mode = await getSetting("tg_client_mode");

    if (mode === "random") {
      const assignedId = (await readAssignments())[String(accountId)];
      const assigned = assignedId
        ? list.find((c) => c.id === assignedId)
        : undefined;
      if (assigned) return await toDeviceParams(accountId, assigned);
      // First random pick for this account -- persist it so it stays stable.
      const picked = list[Math.floor(Math.random() * list.length)];
      await saveAssignment(accountId, picked.id);
      return await toDeviceParams(accountId, picked);
    }

    const def = list.find((c) => c.isDefault);
    return def ? await toDeviceParams(accountId, def) : undefined;
  } catch {
    return undefined;
  }
}
