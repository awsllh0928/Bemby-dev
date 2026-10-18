vi.mock('../jobs/runner', () => ({ runJob: vi.fn() }));
vi.mock('../jobs/cancellation', () => ({
  registerJob: vi.fn().mockReturnValue(new AbortController().signal),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock('../jobs/notify', () => ({
  getNotifyConfig: vi.fn().mockResolvedValue({ events: [], username: null }),
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildSuccessMessage: vi.fn(),
  buildFailureMessage: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  daysUntilNextRun,
  resolveRunEveryDays,
  refreshScheduler,
  getSchedulerStatus,
} from '../scheduler';
import { setSetting } from '../db/repos/settings';
import { updateJob } from '../db/repos/jobs';
import { updateTemplate } from '../db/repos/templates';
import { insert, jobDoc, logDoc, templateDoc, useTestDb } from './helpers/db';
import { waitUntil } from './helpers/async';

// Fixed reference day; window 10:00-12:00 UTC; tests run at 08:00 (before window).
const BASE_DATE = '2024-06-15';
const TZ = 'UTC';
const DAY_MS = 86_400_000;

let nextJobId = 0;
let nextLogId = 0;
let nextTemplateId = 0;

async function insertJob(fields: Partial<{
  runEveryDays: number;
  runEveryDaysMax: number | null;
  scheduleWindowStart: number;
  scheduleWindowEnd: number;
  timezone: string;
  templateId: number | null;
}> = {}): Promise<number> {
  const id = ++nextJobId;
  await insert('jobs', [
    jobDoc({
      _id: id,
      job_type: 'embywatch',
      account_id: null,
      run_every_days: fields.runEveryDays ?? 1,
      run_every_days_max: fields.runEveryDaysMax ?? null,
      schedule_window_start: fields.scheduleWindowStart ?? 1000,
      schedule_window_end: fields.scheduleWindowEnd ?? 1200,
      timezone: fields.timezone ?? TZ,
      template_id: fields.templateId ?? null,
    }),
  ]);
  return id;
}

async function insertTemplate(runEveryDays: number): Promise<number> {
  const id = ++nextTemplateId;
  await insert('job_templates', [
    templateDoc({ _id: id, name: `Tpl ${id}`, run_every_days: runEveryDays }),
  ]);
  return id;
}

/** Records a run N days before the current fake-timer clock. */
async function logRun(jobId: number, daysAgo: number, status = 'success'): Promise<void> {
  await insert('job_logs', [
    logDoc({
      _id: ++nextLogId,
      job_id: jobId,
      ran_at: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
      status,
    }),
  ]);
}

/**
 * refreshScheduler is fire-and-forget by design, so a test waits on what it produces rather
 * than on the call.
 */
async function refreshAndWait(expected: number): Promise<void> {
  refreshScheduler();
  await waitUntil(
    () => getSchedulerStatus().length === expected,
    `${expected} 个任务进入调度表`,
  );
}

const nextRunOf = (id: number) =>
  getSchedulerStatus().find((s) => s.jobId === id)?.nextRun;

/**
 * For a refresh that must move an entry that is already there. Waiting on the count would
 * return at once -- it is already right -- so this watches the run time itself.
 */
async function refreshAndWaitForReschedule(ids: number[], label: string): Promise<void> {
  const before = ids.map(nextRunOf);
  refreshScheduler();
  // Every one of them, not just the first: the assertions that follow are about the whole
  // set having moved, and a refresh that only got halfway through would otherwise pass.
  await waitUntil(
    () => ids.every((id, i) => nextRunOf(id) !== before[i]),
    label,
  );
}

useTestDb();

beforeEach(async () => {
  // `shouldAdvanceTime`: the clock is faked so `pickNextRun` sees a fixed "now", but waiting
  // on the store still needs timers that fire -- `waitUntil` polls with setTimeout.
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 5 });
  vi.setSystemTime(new Date(`${BASE_DATE}T08:00:00Z`));
  vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic: always picks window start

  nextJobId = 0;
  nextLogId = 0;
  nextTemplateId = 0;
  await setSetting('check_daily_run', 'true');

  // Drop whatever the previous test left in the schedule. The database is already empty at
  // this point, so a refresh sees no eligible job and removes every entry.
  refreshScheduler();
  await waitUntil(() => getSchedulerStatus().length === 0, '调度表清空');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── daysUntilNextRun ────────────────────────────────────────────────────────

describe('daysUntilNextRun', () => {
  it('returns 0 when no prior successful run exists', async () => {
    const id = await insertJob();
    expect(await daysUntilNextRun(id, TZ, 1)).toBe(0);
    expect(await daysUntilNextRun(id, TZ, 10)).toBe(0);
  });

  it('returns runEveryDays when job ran today (daysSince = 0)', async () => {
    const id = await insertJob();
    await logRun(id, 0);
    expect(await daysUntilNextRun(id, TZ, 1)).toBe(1);
    expect(await daysUntilNextRun(id, TZ, 10)).toBe(10);
  });

  it('returns remaining interval days when job ran partway through', async () => {
    const id = await insertJob();
    await logRun(id, 3);
    expect(await daysUntilNextRun(id, TZ, 10)).toBe(7); // 10 - 3
    expect(await daysUntilNextRun(id, TZ, 7)).toBe(4);  //  7 - 3
  });

  it('returns 0 when exactly runEveryDays have elapsed', async () => {
    const id = await insertJob();
    await logRun(id, 10);
    expect(await daysUntilNextRun(id, TZ, 10)).toBe(0);
  });

  it('returns 0 when more than runEveryDays have elapsed', async () => {
    const id = await insertJob();
    await logRun(id, 15);
    expect(await daysUntilNextRun(id, TZ, 10)).toBe(0);
  });

  it('ignores failed runs -- treats job as never run', async () => {
    const id = await insertJob();
    await logRun(id, 0, 'failed');
    expect(await daysUntilNextRun(id, TZ, 1)).toBe(0);
  });
});

// ─── run-every-days range ────────────────────────────────────────────────────

describe('run-every-days range', () => {
  it('resolves an interval within [min, max]', async () => {
    const id = await insertJob({ runEveryDays: 7, runEveryDaysMax: 15 });
    await logRun(id, 0);
    const interval = await resolveRunEveryDays(id, 7, 15);
    expect(interval).toBeGreaterThanOrEqual(7);
    expect(interval).toBeLessThanOrEqual(15);
  });

  it('is deterministic within a cycle (stable across calls, not re-rolled)', async () => {
    const id = await insertJob({ runEveryDays: 7, runEveryDaysMax: 15 });
    await logRun(id, 0);
    const a = await resolveRunEveryDays(id, 7, 15);
    const b = await resolveRunEveryDays(id, 7, 15);
    const c = await daysUntilNextRun(id, TZ, 7, 15); // ran today -> full interval
    expect(a).toBe(b);
    expect(c).toBe(a);
  });

  it('defers by the resolved interval minus days elapsed', async () => {
    const id = await insertJob({ runEveryDays: 7, runEveryDaysMax: 15 });
    await logRun(id, 3);
    const interval = await resolveRunEveryDays(id, 7, 15); // same seed (latest success)
    const expected = interval > 3 ? interval - 3 : 0;
    expect(await daysUntilNextRun(id, TZ, 7, 15)).toBe(expected);
  });

  it('re-rolls once a new successful run is recorded', async () => {
    const id = await insertJob({ runEveryDays: 1, runEveryDaysMax: 60 });
    // A wide range makes an accidental collision between two seeds unlikely.
    await logRun(id, 5);
    const first = await resolveRunEveryDays(id, 1, 60);
    await logRun(id, 1);
    const second = await resolveRunEveryDays(id, 1, 60);
    expect(first).not.toBe(second);
  });

  it('behaves as a fixed interval when max is null or <= min', async () => {
    const id = await insertJob({ runEveryDays: 7, runEveryDaysMax: null });
    await logRun(id, 0);
    expect(await daysUntilNextRun(id, TZ, 7, null)).toBe(7);
    expect(await daysUntilNextRun(id, TZ, 7, 5)).toBe(7); // max <= min -> fixed
    expect(await resolveRunEveryDays(id, 7, null)).toBe(7);
  });
});

// ─── First-ever run scheduling ───────────────────────────────────────────────

describe('first-ever run scheduling', () => {
  it('schedules today when job has no run history and window is ahead', async () => {
    // 08:00 UTC, window 10:00-12:00, Math.random=0 → picks 10:00 today
    const id = await insertJob();
    await refreshAndWait(1);

    const [s] = getSchedulerStatus();
    expect(s.jobId).toBe(id);
    expect(s.nextRun.startsWith(BASE_DATE)).toBe(true);
    expect(s.nextRun).toContain('T10:00:00');
  });

  it('schedules tomorrow when job has no run history and window has passed', async () => {
    vi.setSystemTime(new Date(`${BASE_DATE}T13:00:00Z`)); // past 10:00-12:00
    const id = await insertJob();
    await refreshAndWait(1);

    const [s] = getSchedulerStatus();
    expect(s.jobId).toBe(id);
    expect(s.nextRun.startsWith('2024-06-16')).toBe(true);
  });
});

// ─── run_every_days deferral after a successful run ──────────────────────────

describe('run_every_days deferral after a successful run', () => {
  it('defers 1 day when runEveryDays=1 and job ran today', async () => {
    const id = await insertJob({ runEveryDays: 1 });
    await logRun(id, 0);
    await refreshAndWait(1);

    const [s] = getSchedulerStatus();
    expect(s.nextRun.startsWith('2024-06-16')).toBe(true); // +1
    expect(s.nextRun).toContain('T10:00:00');
  });

  it('defers 10 days when runEveryDays=10 and job ran today', async () => {
    const id = await insertJob({ runEveryDays: 10 });
    await logRun(id, 0);
    await refreshAndWait(1);

    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-25')).toBe(true); // +10
  });

  it('defers remaining days when job ran partway through the interval', async () => {
    // ran 3 days ago, interval=10 → 7 more days
    const id = await insertJob({ runEveryDays: 10 });
    await logRun(id, 3);
    await refreshAndWait(1);

    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-22')).toBe(true); // +7
  });

  it('schedules today when the full interval has elapsed', async () => {
    const id = await insertJob({ runEveryDays: 7 });
    await logRun(id, 7); // exactly 7 days ago
    await refreshAndWait(1);

    expect(getSchedulerStatus()[0].nextRun.startsWith(BASE_DATE)).toBe(true);
  });
});

// ─── Rescheduling when run_every_days changes on a standalone job ─────────────

describe('standalone job -- run_every_days change triggers reschedule', () => {
  it('moves next run out when run_every_days increases', async () => {
    const id = await insertJob({ runEveryDays: 1 });
    await logRun(id, 0);
    await refreshAndWait(1);
    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-16')).toBe(true);

    await updateJob(id, { run_every_days: 10 });
    await refreshAndWaitForReschedule([id], 'run_every_days 增大后重新排期');

    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-25')).toBe(true);
  });

  it('moves next run in when run_every_days decreases', async () => {
    const id = await insertJob({ runEveryDays: 10 });
    await logRun(id, 0);
    await refreshAndWait(1);
    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-25')).toBe(true);

    await updateJob(id, { run_every_days: 1 });
    await refreshAndWaitForReschedule([id], 'run_every_days 减小后重新排期');

    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-16')).toBe(true);
  });

  it('schedules today when run_every_days is reduced below days since last run', async () => {
    // ran 5 days ago, interval was 10 (5 days remaining) → reduce to 3 → already overdue
    const id = await insertJob({ runEveryDays: 10 });
    await logRun(id, 5);
    await refreshAndWait(1);
    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-20')).toBe(true); // +5 remaining

    await updateJob(id, { run_every_days: 3 });
    await refreshAndWaitForReschedule([id], 'run_every_days 降到已逾期后重新排期');

    // daysSince(5) >= runEveryDays(3) → return 0 → schedule today
    expect(getSchedulerStatus()[0].nextRun.startsWith(BASE_DATE)).toBe(true);
  });
});

// ─── Template run_every_days change reschedules all linked jobs ───────────────

describe('template run_every_days change reschedules all linked jobs', () => {
  it('all linked jobs move to the new interval after template sync + refreshScheduler', async () => {
    const tpl = await insertTemplate(1);

    const id1 = await insertJob({ runEveryDays: 1, templateId: tpl });
    const id2 = await insertJob({ runEveryDays: 1, templateId: tpl });
    await logRun(id1, 0);
    await logRun(id2, 0);

    await refreshAndWait(2);
    expect(getSchedulerStatus().every(s => s.nextRun.startsWith('2024-06-16'))).toBe(true);

    // Simulate syncLinkedJobs updating both template and linked jobs
    await updateTemplate(tpl, { run_every_days: 10 });
    await updateJob(id1, { run_every_days: 10 });
    await updateJob(id2, { run_every_days: 10 });
    await refreshAndWaitForReschedule([id1, id2], '模板间隔变更后关联任务重新排期');

    const after = getSchedulerStatus();
    expect(after).toHaveLength(2);
    expect(after.every(s => s.nextRun.startsWith('2024-06-25'))).toBe(true);
  });

  it('standalone jobs are not affected when template interval changes', async () => {
    const tpl = await insertTemplate(1);

    const linkedId = await insertJob({ runEveryDays: 1, templateId: tpl });
    const standaloneId = await insertJob({ runEveryDays: 1, templateId: null });
    await logRun(linkedId, 0);
    await logRun(standaloneId, 0);

    await updateTemplate(tpl, { run_every_days: 10 });
    await updateJob(linkedId, { run_every_days: 10 });
    await refreshAndWait(2);

    const statuses = getSchedulerStatus();
    const linked = statuses.find(s => s.jobId === linkedId);
    const standalone = statuses.find(s => s.jobId === standaloneId);

    expect(linked?.nextRun.startsWith('2024-06-25')).toBe(true);
    expect(standalone?.nextRun.startsWith('2024-06-16')).toBe(true);
  });

  it('reduces interval when template run_every_days decreases mid-cycle', async () => {
    const tpl = await insertTemplate(10);

    const id = await insertJob({ runEveryDays: 10, templateId: tpl });
    await logRun(id, 0);
    await refreshAndWait(1);
    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-25')).toBe(true);

    // Template drops to 3 days
    await updateTemplate(tpl, { run_every_days: 3 });
    await updateJob(id, { run_every_days: 3 });
    await refreshAndWaitForReschedule([id], '模板间隔缩短后重新排期');

    // ran today, interval=3 → 3 days from now = 2024-06-18
    expect(getSchedulerStatus()[0].nextRun.startsWith('2024-06-18')).toBe(true);
  });

  it('multiple templates with different intervals reschedule independently', async () => {
    const tplA = await insertTemplate(1);
    const tplB = await insertTemplate(1);

    const idA = await insertJob({ runEveryDays: 1, templateId: tplA });
    const idB = await insertJob({ runEveryDays: 1, templateId: tplB });
    await logRun(idA, 0);
    await logRun(idB, 0);

    // Only template A changes to 7 days
    await updateTemplate(tplA, { run_every_days: 7 });
    await updateJob(idA, { run_every_days: 7 });
    await refreshAndWait(2);

    const statuses = getSchedulerStatus();
    const sA = statuses.find(s => s.jobId === idA);
    const sB = statuses.find(s => s.jobId === idB);

    expect(sA?.nextRun.startsWith('2024-06-22')).toBe(true); // +7
    expect(sB?.nextRun.startsWith('2024-06-16')).toBe(true); // +1, unchanged
  });
});
