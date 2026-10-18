import { Router } from 'express';
import type { Filter } from 'mongodb';
import { col } from '../db/collection';
import { NOCASE, coalesceZero, rankByFuzzy } from '../db/query';
import type { AccountDoc, JobDoc, JobTemplateDoc } from '../db/types';
import {
  allTemplateNames,
  createTemplate,
  deleteTemplate,
  getTemplate,
  linkedJobCounts,
  updateTemplate,
} from '../db/repos/templates';
import {
  createJob,
  NOT_RETIRED,
  updateJob,
  updateJobsByTemplate,
} from '../db/repos/jobs';
import { refreshScheduler } from '../scheduler';
import { parsePaging, textParam } from './list-query';
import type { JobTemplate } from '../types';

const router = Router();

// Normalise a run-every-days range: min >= 1; max kept only when a valid integer
// strictly greater than min, else null (fixed interval).
function normalizeRunEvery(min: unknown, max: unknown): { min: number; max: number | null } {
  const lo = Math.max(1, Math.floor(Number(min ?? 1)) || 1);
  const hiNum = max == null || max === '' ? NaN : Math.floor(Number(max));
  const hi = Number.isFinite(hiNum) && hiNum > lo ? hiNum : null;
  return { min: lo, max: hi };
}

function rowToTemplate(row: JobTemplateDoc): JobTemplate {
  return {
    id: row._id,
    name: row.name,
    jobType: row.job_type as JobTemplate['jobType'],
    botUsername: row.bot_username,
    timezone: row.timezone,
    replyTimeoutMs: row.reply_timeout_ms,
    retryMax: row.retry_max,
    enabled: Boolean(row.enabled),
    config: row.config ?? null,
    startCommand: row.start_command || '/start',
    checkinButton: row.checkin_button || '签到',
    createdAt: row.created_at,
    runEveryDays: row.run_every_days ?? 1,
    runEveryDaysMax: row.run_every_days_max ?? null,
  };
}

// Case-insensitive comparison, standing in for SQLite's `COLLATE NOCASE` (same strength as
// the collation the database queries use).
const collator = new Intl.Collator('en', { strength: 2 } as Intl.CollatorOptions);

// Sync template fields to all linked jobs (enabled is job-specific, not synced)
//
// Exported so the suite exercises this rather than a copy of it: the credential-preserving
// merge below is the part worth testing, and a test that reimplemented the queries would
// pass while the real thing was broken.
export async function syncLinkedJobs(templateId: number, t: JobTemplateDoc) {
  const common = {
    job_type: t.job_type,
    bot_username: t.bot_username,
    timezone: t.timezone,
    reply_timeout_ms: t.reply_timeout_ms,
    retry_max: t.retry_max,
    start_command: t.start_command,
    checkin_button: t.checkin_button,
    run_every_days: t.run_every_days ?? 7,
    run_every_days_max: t.run_every_days_max ?? null,
  };

  if (t.job_type === 'embywatch') {
    // Per-job credentials (username, password) must not be overwritten by the template config.
    // Update all non-config fields in bulk, then merge config per-job.
    await updateJobsByTemplate(templateId, common);

    const tplCfg = t.config ? (JSON.parse(t.config) as Record<string, unknown>) : {};
    const linkedJobs = await col<JobDoc>('jobs')
      .find({ template_id: templateId })
      .toArray();
    for (const job of linkedJobs) {
      const jobCfg = job.config ? (JSON.parse(job.config) as Record<string, unknown>) : {};
      // Spread template config first, then restore per-job credentials on top
      const merged = { ...tplCfg, username: jobCfg.username, password: jobCfg.password };
      await updateJob(job._id, { config: JSON.stringify(merged) });
    }
  } else {
    await updateJobsByTemplate(templateId, { ...common, config: t.config });
  }
  refreshScheduler();
}

// The list view's sort columns. Kept here rather than in a Mongo sort spec because two of
// them are computed outside the database: `linked_job_count` comes from a $group over jobs,
// and a search reorders by the relevance score, which lives in JS now that `fuzzy_score` is.
// Templates number in the dozens, so one comparer over the candidate set is cheap.
function comparer(key: string, counts: Map<number, number>) {
  switch (key) {
    case 'type':
      return (a: JobTemplateDoc, b: JobTemplateDoc) => a.job_type.localeCompare(b.job_type);
    case 'botUrl':
      return (a: JobTemplateDoc, b: JobTemplateDoc) => collator.compare(a.bot_username, b.bot_username);
    // asc shows enabled templates first, matching the previous client-side sort
    case 'enabled':
      return (a: JobTemplateDoc, b: JobTemplateDoc) => Number(b.enabled) - Number(a.enabled);
    case 'linkedJobs':
      return (a: JobTemplateDoc, b: JobTemplateDoc) =>
        (counts.get(a._id) ?? 0) - (counts.get(b._id) ?? 0);
    default:
      return (a: JobTemplateDoc, b: JobTemplateDoc) => collator.compare(a.name, b.name);
  }
}

const toJson = (r: JobTemplateDoc, counts: Map<number, number>) => ({
  ...rowToTemplate(r),
  linkedJobCount: counts.get(r._id) ?? 0,
});

router.get('/', async (req, res) => {
  try {
    const query = req.query as Record<string, unknown>;
    const paging = parsePaging(query);
    const search = textParam(query.search);
    const jobType = textParam(query.jobType);
    const enabled = textParam(query.enabled);
    const sortKey = textParam(query.sortKey);

    const filter: Filter<JobTemplateDoc> = {};
    if (jobType) filter.job_type = jobType;
    if (enabled === '1' || enabled === '0') filter.enabled = Number(enabled);

    const counts = await linkedJobCounts();

    let rows: Array<JobTemplateDoc & { search_score?: number }> =
      await col<JobTemplateDoc>('job_templates').find(filter).toArray();

    if (search) {
      // Fuzzy match against name and bot username (see db/fuzzy.ts). This is both the
      // `fuzzy_score(...) > 0` filter and the relevance score the list can order by.
      rows = rankByFuzzy(rows, search, (r) => `${r.name} ${r.bot_username}`);
    }

    // With a search active and no explicit column sort, order by match relevance
    const useRelevance = Boolean(search) && (!sortKey || sortKey === 'relevance');
    if (useRelevance) {
      rows = [...rows].sort(
        (a, b) => (b.search_score ?? 0) - (a.search_score ?? 0) || collator.compare(a.name, b.name),
      );
    } else {
      const cmp = comparer(sortKey, counts);
      const dir = query.sortDir === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, b) => dir * cmp(a, b));
    }

    if (!paging) {
      res.json(rows.map((r) => toJson(r, counts)));
      return;
    }

    const pageRows =
      paging.limit > 0
        ? rows.slice(paging.offset, paging.offset + paging.limit)
        : rows.slice(paging.offset);

    res.json({
      items: pageRows.map((r) => toJson(r, counts)),
      total: rows.length,
      page: paging.page,
      pageSize: paging.pageSize,
    });
  } catch (e) {
    console.error('[templates] list failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  const {
    name,
    jobType,
    botUsername,
    timezone,
    replyTimeoutMs,
    retryMax,
    config,
    startCommand,
    checkinButton,
    runEveryDays,
    runEveryDaysMax,
  } = req.body as Record<string, any>;

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  try {
    const runEvery = normalizeRunEvery(runEveryDays, runEveryDaysMax);
    const id = await createTemplate({
      name,
      job_type: jobType ?? 'checkin',
      bot_username: (botUsername as string | undefined)?.replace(/^@+/, '') ?? '',
      timezone: timezone ?? '',
      reply_timeout_ms: Number(replyTimeoutMs ?? 40000),
      retry_max: Number(retryMax ?? 5),
      // MySQL-style defaults are gone with the schema: the column was `enabled DEFAULT 1`.
      enabled: 1,
      config: config != null ? JSON.stringify(config) : null,
      start_command: (startCommand as string | undefined)?.trim() || '/start',
      checkin_button: (checkinButton as string | undefined)?.trim() || '签到',
      run_every_days: runEvery.min,
      run_every_days_max: runEvery.max,
    });

    const row = await getTemplate(id);
    res.status(201).json(rowToTemplate(row as JobTemplateDoc));
  } catch (e) {
    console.error('[templates] create failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * `<name> (copy)`, or `(copy 2)` and up when that is taken. Templates are picked from a
 * list by name, so a duplicate reading exactly like its source is of little use.
 */
async function copyName(name: string): Promise<string> {
  const taken = new Set(await allTemplateNames());
  let candidate = `${name} (copy)`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name} (copy ${n})`;
  return candidate;
}

router.post('/:id/duplicate', async (req, res) => {
  try {
    const source = await getTemplate(Number(req.params.id));
    if (!source) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Everything the source configures, nothing about its identity: the copy starts with no
    // linked jobs, which stay with the original.
    const id = await createTemplate({
      name: await copyName(source.name),
      job_type: source.job_type,
      bot_username: source.bot_username,
      timezone: source.timezone,
      reply_timeout_ms: source.reply_timeout_ms,
      retry_max: source.retry_max,
      enabled: source.enabled,
      config: source.config ?? null,
      start_command: source.start_command,
      checkin_button: source.checkin_button,
      run_every_days: source.run_every_days,
      run_every_days_max: source.run_every_days_max ?? null,
    });

    const row = await getTemplate(id);
    res.status(201).json(rowToTemplate(row as JobTemplateDoc));
  } catch (e) {
    console.error('[templates] duplicate failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await getTemplate(id);
    if (!existing) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const {
      name,
      jobType,
      botUsername,
      timezone,
      replyTimeoutMs,
      retryMax,
      enabled,
      config,
      startCommand,
      checkinButton,
      runEveryDays,
      runEveryDaysMax,
    } = req.body as Record<string, any>;

    const runEvery = normalizeRunEvery(
      runEveryDays !== undefined ? runEveryDays : existing.run_every_days,
      runEveryDaysMax !== undefined ? runEveryDaysMax : existing.run_every_days_max,
    );
    const updated: JobTemplateDoc = {
      ...existing,
      name: name ?? existing.name,
      job_type: jobType ?? existing.job_type,
      bot_username: (botUsername as string | undefined)?.replace(/^@+/, '') ?? existing.bot_username,
      timezone: timezone ?? existing.timezone,
      reply_timeout_ms: Number(replyTimeoutMs ?? existing.reply_timeout_ms),
      retry_max: Number(retryMax ?? existing.retry_max),
      enabled: enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      config: config !== undefined
        ? (config != null ? JSON.stringify(config) : null)
        : existing.config,
      start_command: startCommand !== undefined
        ? ((startCommand as string).trim() || '/start')
        : existing.start_command,
      checkin_button: checkinButton !== undefined
        ? ((checkinButton as string).trim() || '签到')
        : existing.checkin_button,
      run_every_days: runEvery.min,
      run_every_days_max: runEvery.max,
    };

    await updateTemplate(id, {
      name: updated.name,
      job_type: updated.job_type,
      bot_username: updated.bot_username,
      timezone: updated.timezone,
      reply_timeout_ms: updated.reply_timeout_ms,
      retry_max: updated.retry_max,
      enabled: updated.enabled,
      config: updated.config,
      start_command: updated.start_command,
      checkin_button: updated.checkin_button,
      run_every_days: updated.run_every_days,
      run_every_days_max: updated.run_every_days_max,
    });

    await syncLinkedJobs(id, updated);

    const row = await getTemplate(id);
    res.json(rowToTemplate(row as JobTemplateDoc));
  } catch (e) {
    console.error('[templates] update failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    // The repository reproduces ON DELETE SET NULL by unlinking jobs itself.
    await deleteTemplate(Number(req.params.id));
    res.status(204).send();
  } catch (e) {
    console.error('[templates] delete failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Bulk enable / disable linked jobs ────────────────────────────────────────

router.put('/:id/jobs/enabled', async (req, res) => {
  try {
    const { enabled } = req.body as { enabled: boolean };
    await updateJobsByTemplate(Number(req.params.id), { enabled: enabled ? 1 : 0 });
    refreshScheduler();
    res.json({ ok: true });
  } catch (e) {
    console.error('[templates] set linked jobs enabled failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Candidate accounts (no existing job for this template) ───────────────────

router.get('/:id/available-accounts', async (req, res) => {
  try {
    const templateId = Number(req.params.id);
    // The `NOT IN (SELECT account_id FROM jobs WHERE template_id = ?)` exclusion.
    const excluded = await col<JobDoc>('jobs')
      .find({ template_id: templateId, account_id: { $ne: null }, ...NOT_RETIRED })
      .toArray();
    const usedIds = excluded
      .map((j) => j.account_id)
      .filter((id): id is number => id != null);

    const rows = await col<AccountDoc>('tg_accounts')
      .find({
        // disabled = 0 OR disabled IS NULL: a document predating the column omits it.
        disabled: coalesceZero(0) as AccountDoc['disabled'],
        ...(usedIds.length ? { _id: { $nin: usedIds } } : {}),
      })
      .sort({ name: 1 })
      .collation(NOCASE)
      .toArray();

    res.json(rows.map((r) => ({
      id: r._id,
      name: r.name,
      phoneNumber: r.phone_number,
      authStatus: r.auth_status,
      tgDisplayName: r.tg_display_name ?? null,
    })));
  } catch (e) {
    console.error('[templates] available accounts failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Bulk create jobs from template ───────────────────────────────────────────

type CreateJobEntry = {
  accountId: number;
  name: string;
  config?: Record<string, unknown>;
};

router.post('/:id/create-jobs', async (req, res) => {
  try {
    const templateId = Number(req.params.id);
    const template = await getTemplate(templateId);
    if (!template) { res.status(404).json({ error: 'Not found' }); return; }

    const { jobs, scheduleWindowStart, scheduleWindowEnd } = req.body as {
      jobs: CreateJobEntry[];
      scheduleWindowStart: number;
      scheduleWindowEnd: number;
    };

    if (!Array.isArray(jobs) || !jobs.length) {
      res.status(400).json({ error: 'jobs array is required' }); return;
    }

    const createdIds: number[] = [];

    // SQLite wrapped these inserts in one transaction so a failure left nothing behind.
    // MongoDB transactions need a replica set, which a standalone install does not have, so
    // this writes sequentially and accepts that a mid-way failure leaves some jobs created.
    for (const j of jobs) {
      // For embywatch, merge per-job credentials into template config
      let jobConfig = template.config ?? null;
      if (j.config && template.job_type === 'embywatch') {
        const tplCfg = template.config ? JSON.parse(template.config) : {};
        jobConfig = JSON.stringify({ ...tplCfg, ...j.config });
      }

      const id = await createJob({
        name: j.name,
        account_id: j.accountId,
        job_type: template.job_type,
        bot_username: template.bot_username,
        schedule_window_start: Number(scheduleWindowStart),
        schedule_window_end: Number(scheduleWindowEnd),
        timezone: template.timezone,
        reply_timeout_ms: template.reply_timeout_ms,
        retry_max: template.retry_max,
        enabled: 1,
        config: jobConfig,
        start_command: template.start_command,
        checkin_button: template.checkin_button,
        template_id: template._id,
      });
      createdIds.push(id);
    }

    refreshScheduler();
    res.status(201).json({ created: createdIds.length, ids: createdIds });
  } catch (e) {
    console.error('[templates] create jobs failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
