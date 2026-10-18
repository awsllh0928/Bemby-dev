import { Router } from 'express';
import { col } from '../db/collection';
import { allSettings, getSetting, setSetting, setSettings, deleteSetting } from '../db/repos/settings';
import { createAccount, findAccountByPhone } from '../db/repos/accounts';
import { createJob } from '../db/repos/jobs';
import { createTemplate } from '../db/repos/templates';
import { createSupplier, createModel } from '../db/repos/ai';
import type {
  AccountDoc,
  AiModelDoc,
  AiSupplierDoc,
  JobDoc,
  JobTemplateDoc,
} from '../db/types';
import { decryptPayload, encryptPayload, type EncryptedEnvelope } from '../db/exportCrypto';
import { decryptAccountRow, encryptSecret } from '../db/secretColumns';
import { refreshScheduler } from '../scheduler';
import {
  verifyPassword,
  legacyHashPassword,
  timingSafeCompare,
  getStoredCredentials,
} from '../auth/credentials';
import {
  savePasskeySecret,
  parseStoredPasskey,
  importedPasskeyFor,
  type StoredPasskey,
} from '../tg/passkeyStore';
import {
  parseAttributes,
  writeAttributes,
  foldImportedAttributes,
  LEGACY_PASSKEY_STORE_KEY,
} from '../db/accountAttributes';

// Admin/JWT secrets are instance-local and must never travel in a backup.
export const EXPORT_EXCLUDED_SETTINGS = new Set([
  'admin_password_hash',
  'admin_username',
  'jwt_secret',
  // References an instance-local ai_models row id; meaningless after import
  'ai_default_model_id',
]);

// Settings whose presence forces the export to be encrypted. Proxy entries carry their
// credentials in the URL, and a provider entry carries the seller's API token.
export const SENSITIVE_SETTING_KEYS = [
  'default_tg_api_hash',
  'proxies',
  'proxy_providers',
  'webshare_api_key',
  // Whoever holds the notification bot's token can act as that bot
  'notify_bot_token',
];

// Config keys that carry a credential (e.g. Emby login) inside a job/template config blob.
const SENSITIVE_CONFIG_KEYS = ['password', 'username'];

/** True if a job/template config JSON string carries a credential field. */
function configHasSecret(config: string | null | undefined): boolean {
  if (!config) return false;
  try {
    const parsed = JSON.parse(config) as Record<string, unknown>;
    return SENSITIVE_CONFIG_KEYS.some((k) => Boolean(parsed?.[k]));
  } catch {
    return false;
  }
}

// Encryption is mandatory when the payload carries any credential-bearing field:
// session strings, API keys, per-account API hashes, sensitive settings, or an
// Emby username/password embedded in a job/template config.
export function exportRequiresEncryption(
  payload: Pick<ExportPayload, 'accounts' | 'aiSuppliers' | 'settings'> &
    Partial<Pick<ExportPayload, 'jobs' | 'templates'>>,
): boolean {
  return (
    payload.accounts.some(
      (a) => a.sessionString || a.apiHash || a.passkey?.privateKeyPem,
    ) ||
    (payload.aiSuppliers ?? []).some((s) => s.apiKey) ||
    SENSITIVE_SETTING_KEYS.some((k) => Boolean(payload.settings?.[k])) ||
    (payload.jobs ?? []).some((j) => configHasSecret(j.config)) ||
    (payload.templates ?? []).some((t) => configHasSecret(t.config))
  );
}

const router = Router();

type AccountRow = {
  _id: number;
  name: string;
  phone_number: string;
  api_id: number;
  api_hash: string;
  session_string: string | null;
  auth_status: string;
  proxy_id: string | null;
  passkey: string | null;
  additional_attributes: string | null;
};

type JobRow = {
  _id: number;
  account_id: number | null;
  template_id: number | null;
  name: string;
  job_type: string;
  bot_username: string;
  schedule_window_start: number;
  schedule_window_end: number;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
};

type TemplateRow = {
  _id: number;
  name: string;
  job_type: string;
  bot_username: string;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
};

type AiSupplierRow = {
  _id: number;
  name: string;
  base_url: string;
  api_key: string;
  timeout_ms: number;
};

type AiModelRow = {
  _id: number;
  supplier_id: number;
  model_id: string;
  label: string | null;
};

export type ExportPayload = {
  version: '1';
  exportedAt: string;
  accounts: Array<{
    name: string;
    phoneNumber: string;
    apiId: number;
    apiHash: string;
    sessionString: string | null;
    authStatus: string;
    proxyId?: string | null;
    // Passkey secret and generic flags travel inline with the account so nothing needs
    // remapping on import (a raw settings blob would keep stale, detached account ids).
    passkey?: StoredPasskey | null;
    additionalAttributes?: Record<string, unknown> | null;
  }>;
  templates?: Array<{
    name: string;
    jobType: string;
    botUsername: string;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    config: string | null;
    startCommand: string;
    checkinButton: string;
  }>;
  jobs: Array<{
    /** Index into the accounts array; null for jobs that don't require an account */
    accountIndex: number | null;
    /** Index into the templates array; null if not linked to a template */
    templateIndex?: number | null;
    name: string;
    jobType: string;
    botUsername: string;
    scheduleWindowStart: number;
    scheduleWindowEnd: number;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    enabled: boolean;
    config: string | null;
    startCommand: string;
    checkinButton: string;
  }>;
  aiSuppliers?: Array<{
    name: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  }>;
  aiModels?: Array<{
    /** Index into the aiSuppliers array */
    supplierIndex: number;
    modelId: string;
    label: string | null;
  }>;
  settings: Record<string, string>;
};

/** Ids of the proxies currently configured, for validating references against. */
async function configuredProxyIds(): Promise<Set<string>> {
  const value = await getSetting('proxies');
  try {
    const list = JSON.parse(value ?? '[]') as Array<{ id?: string }>;
    return new Set(list.map((p) => p.id).filter((id): id is string => !!id));
  } catch {
    return new Set();
  }
}

/**
 * Drops proxy references that point at proxies this instance does not have: the account
 * column, and the `proxyId` inside job and template configs. Returns how many were
 * cleared. A dangling reference is worse than none, because it silently resolves to no
 * proxy at all instead of the one the job was set up with.
 */
export async function clearDanglingProxyRefs(): Promise<number> {
  const known = await configuredProxyIds();
  let cleared = 0;

  const accounts = await col<AccountDoc>('tg_accounts')
    .find({ proxy_id: { $nin: [null, ''] } })
    .toArray();
  for (const a of accounts) {
    if (known.has(a.proxy_id as string)) continue;
    await col<AccountDoc>('tg_accounts').updateOne({ _id: a._id }, { $set: { proxy_id: null } });
    cleared++;
  }

  for (const table of ['jobs', 'job_templates'] as const) {
    // SQLite matched `config LIKE '%proxyId%'` to skip rows whose JSON could not carry the
    // key at all. Same narrowing: pull only rows whose config mentions it, then parse.
    const rows = await col<JobDoc | JobTemplateDoc>(table)
      .find({ config: { $regex: 'proxyId' } })
      .toArray() as Array<{ _id: number; config: string }>;
    for (const row of rows) {
      let cfg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.config);
        cfg = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      } catch {
        continue;
      }
      const proxyId = cfg?.proxyId;
      if (typeof proxyId !== 'string' || !proxyId || known.has(proxyId)) continue;
      delete cfg.proxyId;
      await col<JobDoc | JobTemplateDoc>(table).updateOne(
        { _id: row._id },
        { $set: { config: JSON.stringify(cfg) } },
      );
      cleared++;
    }
  }

  return cleared;
}

router.post('/export', async (req, res) => {
  const { secret } = req.body as { secret?: string };

  try {
  const accounts = ((await col<AccountDoc>('tg_accounts').find({}).sort({ _id: 1 }).toArray()) as AccountRow[])
    // The backup has its own encryption; the at-rest key must not be needed to restore it
    .map(decryptAccountRow);
  const templates = (await col<JobTemplateDoc>('job_templates').find({}).sort({ _id: 1 }).toArray()) as TemplateRow[];
  const jobs = (await col<JobDoc>('jobs').find({}).sort({ _id: 1 }).toArray()) as JobRow[];
  const aiSuppliers = (await col<AiSupplierDoc>('ai_suppliers').find({}).sort({ _id: 1 }).toArray()) as AiSupplierRow[];
  const aiModels = (await col<AiModelDoc>('ai_models').find({}).sort({ _id: 1 }).toArray()) as AiModelRow[];
  const settings = await allSettings();

  const accountIdToIndex = new Map(accounts.map((a, i) => [a._id, i]));
  const templateIdToIndex = new Map(templates.map((t, i) => [t._id, i]));
  const supplierIdToIndex = new Map(aiSuppliers.map((s, i) => [s._id, i]));

  const payload: ExportPayload = {
    version: '1',
    exportedAt: new Date().toISOString(),
    accounts: accounts.map(a => ({
      name: a.name,
      phoneNumber: a.phone_number,
      apiId: a.api_id,
      apiHash: a.api_hash,
      sessionString: a.session_string,
      authStatus: a.auth_status,
      proxyId: a.proxy_id ?? null,
      passkey: parseStoredPasskey(a.passkey),
      additionalAttributes: parseAttributes(a.additional_attributes),
    })),
    templates: templates.map(t => ({
      name: t.name,
      jobType: t.job_type,
      botUsername: t.bot_username,
      timezone: t.timezone,
      replyTimeoutMs: t.reply_timeout_ms,
      retryMax: t.retry_max,
      config: t.config,
      startCommand: t.start_command,
      checkinButton: t.checkin_button,
    })),
    jobs: jobs.map(j => ({
      accountIndex: j.account_id != null ? (accountIdToIndex.get(j.account_id) ?? null) : null,
      templateIndex: j.template_id != null ? (templateIdToIndex.get(j.template_id) ?? null) : null,
      name: j.name,
      jobType: j.job_type,
      botUsername: j.bot_username,
      scheduleWindowStart: j.schedule_window_start,
      scheduleWindowEnd: j.schedule_window_end,
      timezone: j.timezone,
      replyTimeoutMs: j.reply_timeout_ms,
      retryMax: j.retry_max,
      enabled: j.enabled === 1,
      config: j.config,
      startCommand: j.start_command,
      checkinButton: j.checkin_button,
    })),
    aiSuppliers: aiSuppliers.map(s => ({
      name: s.name,
      baseUrl: s.base_url,
      apiKey: s.api_key,
      timeoutMs: s.timeout_ms,
    })),
    aiModels: aiModels
      .filter(m => supplierIdToIndex.has(m.supplier_id))
      .map(m => ({
        supplierIndex: supplierIdToIndex.get(m.supplier_id)!,
        modelId: m.model_id,
        label: m.label,
      })),
    settings: Object.fromEntries(
      Object.entries(settings)
        // Passkeys now live on the account row (exported per-account above), never as a
        // setting. Exclude the legacy blob in case an un-migrated DB still holds it.
        .filter(([key]) => !EXPORT_EXCLUDED_SETTINGS.has(key) && key !== LEGACY_PASSKEY_STORE_KEY),
    ),
  };

  const hasSecrets = exportRequiresEncryption(payload);

  if (hasSecrets && !secret) {
    res.status(400).json({
      error: 'This export contains sensitive credentials (session strings or API keys). Provide an encryption secret.',
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
    console.error('[data] export failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/import', async (req, res) => {
  let { data, mode, secret, forceReauth = true, confirmPassword } = req.body as { data: ExportPayload | EncryptedEnvelope; mode: 'merge' | 'replace'; secret?: string; forceReauth?: boolean; confirmPassword?: string };

  if (data && (data as EncryptedEnvelope).encrypted === true) {
    if (!secret) {
      res.status(400).json({ error: 'This backup is encrypted. Please provide the secret to decrypt it.' });
      return;
    }
    try {
      data = JSON.parse(decryptPayload(data as EncryptedEnvelope, secret)) as ExportPayload;
    } catch {
      res.status(400).json({ error: 'Incorrect secret or corrupted backup file', code: 'WRONG_SECRET' });
      return;
    }
  }

  const payload = data as ExportPayload;

  if (!payload || payload.version !== '1') {
    res.status(400).json({ error: 'Invalid or unsupported export file' });
    return;
  }

  if (!Array.isArray(payload.accounts) || !Array.isArray(payload.jobs)) {
    res.status(400).json({ error: 'Malformed export file: missing accounts or jobs' });
    return;
  }

  if (mode === 'replace') {
    if (!confirmPassword) {
      res.status(400).json({ error: 'Current password confirmation is required for replace-mode import.', code: 'CONFIRM_REQUIRED' });
      return;
    }
    const stored = await getStoredCredentials();
    // With no stored hash and no ADMIN_PASSWORD, the old fallback compared the input against
    // the hash of the empty string, so an empty confirmPassword passed. Refuse outright
    // instead: there is nothing to check against, and a wipe is not the place to fail open.
    const envPassword = process.env.ADMIN_PASSWORD;
    const valid = stored.passwordHash
      ? await verifyPassword(confirmPassword, stored.passwordHash)
      : envPassword
        ? timingSafeCompare(legacyHashPassword(confirmPassword), legacyHashPassword(envPassword))
        : false;
    if (!valid) {
      res.status(401).json({ error: 'Incorrect password', code: 'WRONG_PASSWORD' });
      return;
    }
  }

  const results = { accountsImported: 0, accountsSkipped: 0, templatesImported: 0, jobsImported: 0, aiSuppliersImported: 0, aiModelsImported: 0, settingsUpdated: 0, proxyRefsCleared: 0 };

  try {
    // SQLite ran this whole sequence inside one transaction, so a malformed backup left the
    // database untouched. MongoDB transactions need a replica set -- which a single-node
    // install will not have -- so the writes below are sequential instead. A failure part-way
    // through therefore leaves partially imported data behind, and the counts returned to the
    // client are what tells the operator how far it got. Re-running a merge import skips what
    // already landed (by phone number, template name and supplier name), which makes it safe
    // to retry.
    if (mode === 'replace') {
      // Dependent-first: models before suppliers, jobs before templates/accounts.
      await col('ai_models').deleteMany({});
      await col('ai_suppliers').deleteMany({});
      await col('jobs').deleteMany({});
      await col('job_templates').deleteMany({});
      await col('tg_accounts').deleteMany({});
      // The pinned default references a wiped ai_models row id
      await deleteSetting('ai_default_model_id');
    }

    // Import accounts and build accountIndex -> new db id mapping
    const accountIndexToId = new Map<number, number>();

    for (let i = 0; i < payload.accounts.length; i++) {
      const a = payload.accounts[i];

      if (mode === 'merge') {
        const existing = await findAccountByPhone(a.phoneNumber);
        if (existing) {
          accountIndexToId.set(i, existing._id);
          results.accountsSkipped++;
          continue;
        }
      }

      const newAccountId = await createAccount({
        name: a.name,
        phone_number: a.phoneNumber,
        api_id: a.apiId,
        api_hash: encryptSecret(a.apiHash),
        session_string: encryptSecret(forceReauth ? null : (a.sessionString ?? null)),
        auth_status: forceReauth ? 'unauthenticated' : (a.authStatus ?? 'unauthenticated'),
        proxy_id: a.proxyId ?? null,
      });
      accountIndexToId.set(i, newAccountId);
      // Restore the passkey secret under the new account id so passkey login still works
      // after import (even when force-reauth clears the session string).
      const pk = importedPasskeyFor(a);
      if (pk) await savePasskeySecret({ ...pk, accountId: newAccountId });
      // Restore the generic attributes bag.
      const attrs = foldImportedAttributes(a);
      if (attrs) await writeAttributes(newAccountId, attrs);
      results.accountsImported++;
    }

    // Import templates and build templateIndex -> new db id mapping
    const templateIndexToId = new Map<number, number>();

    if (Array.isArray(payload.templates)) {
      for (let i = 0; i < payload.templates.length; i++) {
        const t = payload.templates[i];

        if (mode === 'merge') {
          const existing = await col<JobTemplateDoc>('job_templates').findOne({ name: t.name });
          if (existing) {
            templateIndexToId.set(i, existing._id);
            continue;
          }
        }

        const newTemplateId = await createTemplate({
          name: t.name,
          job_type: t.jobType ?? 'checkin',
          bot_username: t.botUsername ?? '',
          timezone: t.timezone ?? '',
          reply_timeout_ms: t.replyTimeoutMs ?? 40000,
          retry_max: t.retryMax ?? 5,
          enabled: 1,
          config: t.config ?? null,
          start_command: t.startCommand ?? '/start',
          checkin_button: t.checkinButton ?? '签到',
        });

        templateIndexToId.set(i, newTemplateId);
        results.templatesImported++;
      }
    }

    // Import jobs
    for (const j of payload.jobs) {
      const resolvedAccountId = j.accountIndex != null ? (accountIndexToId.get(j.accountIndex) ?? null) : null;
      const resolvedTemplateId = j.templateIndex != null ? (templateIndexToId.get(j.templateIndex) ?? null) : null;

      await createJob({
        account_id: resolvedAccountId,
        template_id: resolvedTemplateId,
        name: j.name,
        job_type: j.jobType ?? 'checkin',
        bot_username: j.botUsername,
        schedule_window_start: j.scheduleWindowStart ?? 1400,
        schedule_window_end: j.scheduleWindowEnd ?? 1600,
        timezone: j.timezone ?? '',
        reply_timeout_ms: j.replyTimeoutMs ?? 40000,
        retry_max: j.retryMax ?? 5,
        enabled: j.enabled ? 1 : 0,
        config: j.config ?? null,
        start_command: j.startCommand ?? '/start',
        checkin_button: j.checkinButton ?? '签到',
        retired: null,
        run_every_days: 1,
      });
      results.jobsImported++;
    }

    // Import AI suppliers and build supplierIndex -> new db id mapping
    const supplierIndexToId = new Map<number, number>();

    if (Array.isArray(payload.aiSuppliers)) {
      for (let i = 0; i < payload.aiSuppliers.length; i++) {
        const s = payload.aiSuppliers[i];

        if (mode === 'merge') {
          const existing = await col<AiSupplierDoc>('ai_suppliers').findOne({ name: s.name });
          if (existing) {
            supplierIndexToId.set(i, existing._id);
            continue;
          }
        }

        const newSupplierId = await createSupplier({
          name: s.name,
          base_url: s.baseUrl,
          api_key: s.apiKey,
          timeout_ms: s.timeoutMs ?? 25000,
        });

        supplierIndexToId.set(i, newSupplierId);
        results.aiSuppliersImported++;
      }
    }

    // Import AI models
    if (Array.isArray(payload.aiModels)) {
      for (const m of payload.aiModels) {
        const resolvedSupplierId = supplierIndexToId.get(m.supplierIndex);
        if (resolvedSupplierId == null) continue;

        await createModel({ supplier_id: resolvedSupplierId, model_id: m.modelId, label: m.label ?? null });
        results.aiModelsImported++;
      }
    }

    // Merge settings -- never let a backup overwrite instance-local admin/JWT secrets
    if (payload.settings && typeof payload.settings === 'object') {
      const merged: Record<string, string> = {};
      for (const [key, value] of Object.entries(payload.settings)) {
        if (EXPORT_EXCLUDED_SETTINGS.has(key)) continue;
        // Never merge a legacy raw passkey blob: passkeys live on the account row now,
        // and an older backup's blob carries stale account ids.
        if (key === LEGACY_PASSKEY_STORE_KEY) continue;
        if (typeof value === 'string') {
          merged[key] = value;
          results.settingsUpdated++;
        }
      }
      await setSettings(merged);
    }

    // A proxy reference is an id that only means something next to the proxy list it came
    // from: a backup taken without proxies, or one imported into an instance with its own,
    // leaves accounts and jobs pointing at nothing. That reads as "no proxy" at run time
    // rather than as an error, so the dangling references are cleared here and counted.
    results.proxyRefsCleared = await clearDanglingProxyRefs();
  } catch (err) {
    // A malformed backup can throw part-way through. Respond rather than letting the
    // rejection escape the async handler and hang the request. Unlike the SQLite build this
    // cannot roll back -- see the note above the try block.
    res.status(400).json({
      error: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  refreshScheduler();
  res.json({ message: 'Import complete', ...results });
});

export default router;
