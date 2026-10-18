import {
  getDefaultTgApiCredentials,
  getDefaultTimezone,
  FALLBACK_TIMEZONE,
} from "./db/database";
import { col } from "./db/collection";
import { getSetting } from "./db/repos/settings";
import { latestRunAt, purgeLogsOlderThan, failRunningLogs } from "./db/repos/logs";
import { runStarted, updateLog } from "./db/repos/logs";
import type { AccountDoc, JobDoc } from "./db/types";
import { decryptSecret } from "./db/secretColumns";
import { runJob, type JobDetailLog } from "./jobs/runner";
import {
  notifyJobEvent,
  buildFailureMessage,
  buildSuccessMessage,
} from "./jobs/notify";
import type { Job, JobType, TgAccount } from "./types";
import { DateTime, IANAZone } from "luxon";
import {
  registerJob,
  unregisterJob,
  registerLiveDetail,
  clearLiveDetail,
} from "./jobs/cancellation";
import { toMinutes, pickNextRun } from "./scheduler-utils";
import { collectRunWarnings, completedMessage } from "./jobs/runWarnings";

type ScheduleEntry = {
  job: Job;
  account: TgAccount | null;
  /** Timezone the nextRun was computed in, after resolving the default. */
  timezone: string;
  nextRun: Date;
  timer: ReturnType<typeof setTimeout>;
};

const schedule = new Map<number, ScheduleEntry>();

/** Node's setTimeout delay is a 32-bit signed int; larger values overflow and
 * fire almost immediately (coerced to 1ms). See issue #25. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * setTimeout for delays that may exceed Node's 32-bit limit (~24.8 days).
 * Chains timers, re-arming until the remaining delay fits. `onTimer` is called
 * with each armed timer handle so the caller can keep a clearable reference to
 * the currently-pending timer.
 */
function armLongTimeout(
  delayMs: number,
  callback: () => void,
  onTimer: (timer: ReturnType<typeof setTimeout>) => void,
): void {
  if (delayMs <= MAX_TIMEOUT_MS) {
    onTimer(setTimeout(callback, delayMs));
    return;
  }
  onTimer(
    setTimeout(
      () => armLongTimeout(delayMs - MAX_TIMEOUT_MS, callback, onTimer),
      MAX_TIMEOUT_MS,
    ),
  );
}

export const DEFAULT_SCHEDULE_GAP_MINUTES = 2;
const MAX_SCHEDULE_GAP_MINUTES = 30;

/** Minimum minutes between scheduled runs. 0 disables staggering. */
export async function getScheduleGapMinutes(): Promise<number> {
  const value = await getSetting("schedule_min_gap_minutes");
  if (value == null || value === "") return DEFAULT_SCHEDULE_GAP_MINUTES;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SCHEDULE_GAP_MINUTES;
  return Math.min(MAX_SCHEDULE_GAP_MINUTES, Math.max(0, Math.floor(n)));
}

// Cap on simultaneous job executions -- colliding timers queue instead of
// thundering the Telegram client all at once.
const MAX_CONCURRENT_JOBS = 2;
let runningJobs = 0;
const waitingJobs: Array<() => void> = [];

async function acquireRunSlot(): Promise<void> {
  if (runningJobs < MAX_CONCURRENT_JOBS) {
    runningJobs++;
    return;
  }
  // Slot is handed over directly by releaseRunSlot, so no counter change here
  await new Promise<void>((resolve) => waitingJobs.push(resolve));
}

function releaseRunSlot(): void {
  const next = waitingJobs.shift();
  if (next) next();
  else runningJobs--;
}

/**
 * Resolves a job's timezone for scheduling. Empty means "follow the
 * default_timezone setting"; invalid zones fall back rather than producing
 * NaN timers.
 */
export async function resolveJobTimezone(
  jobTimezone: string | null | undefined,
): Promise<string> {
  const tz = jobTimezone || (await getDefaultTimezone());
  if (IANAZone.isValidZone(tz)) return tz;
  const fallback = await getDefaultTimezone();
  return IANAZone.isValidZone(fallback) ? fallback : FALLBACK_TIMEZONE;
}

async function checkDailyRunEnabled(): Promise<boolean> {
  const value = await getSetting("check_daily_run");
  return value !== "false";
}

// Small deterministic PRNG (FNV-1a hash seed -> mulberry32 step) so a run-every
// range resolves to a value that is stable for a given seed, not re-rolled on
// every scheduler refresh.
function seededRandom(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = (h + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Resolve the effective interval from a [min, max] range for a given seed. A
// null/absent max (or max <= min) yields the fixed min, preserving the old
// single-value behaviour exactly.
function intervalFromSeed(
  min: number,
  max: number | null | undefined,
  seed: string,
): number {
  const lo = Math.max(1, Math.floor(min));
  const hi = max != null ? Math.floor(max) : lo;
  if (hi <= lo) return lo;
  return lo + Math.floor(seededRandom(seed) * (hi - lo + 1));
}

/**
 * The interval to defer by after a run, resolved from the range. Seeded by the
 * job's last successful run so the value stays stable across refreshes/restarts
 * within a cycle and re-rolls only once a new successful run is recorded.
 */
export async function resolveRunEveryDays(
  jobId: number,
  min: number,
  max?: number | null,
): Promise<number> {
  const ranAt = await latestRunAt(jobId, "success");
  return intervalFromSeed(min, max, `${jobId}:${ranAt ?? "first"}`);
}

export async function daysUntilNextRun(
  jobId: number,
  tz: string,
  runEveryDays: number,
  runEveryDaysMax?: number | null,
): Promise<number> {
  const ranAt = await latestRunAt(jobId, "success");
  if (!ranAt) return 0;
  // Same seed as resolveRunEveryDays so the scheduled date is consistent whether
  // it was set after a run or recomputed on restart.
  const runEvery = intervalFromSeed(runEveryDays, runEveryDaysMax, `${jobId}:${ranAt}`);
  const lastRun = DateTime.fromISO(ranAt, { zone: "utc" })
    .setZone(tz)
    .startOf("day");
  const today = DateTime.now().setZone(tz).startOf("day");
  const daysSince = Math.floor(today.diff(lastRun, "days").days);
  return daysSince >= runEvery ? 0 : runEvery - daysSince;
}

/**
 * Jobs that may be scheduled, each with the account it runs under.
 *
 * SQLite answered this with one LEFT JOIN whose WHERE clause filtered on joined columns
 * (`a.disabled = 0`, `a.auth_status = 'authenticated'`). MongoDB cannot filter a left-joined
 * document inside $lookup's own match, so the two collections are read separately and joined
 * here -- at most a few hundred rows, loaded once every five minutes.
 */
export async function loadEligibleJobs(): Promise<
  Array<{ job: Job; account: TgAccount | null }>
> {
  const jobs = (await col<JobDoc>("jobs")
    .find({ enabled: 1, retired: null })
    .toArray()) as JobDoc[];

  const accountIds = [
    ...new Set(jobs.map((j) => j.account_id).filter((id): id is number => id != null)),
  ];
  const accounts = accountIds.length
    ? await col<AccountDoc>("tg_accounts").find({ _id: { $in: accountIds } }).toArray()
    : [];
  const accountsById = new Map(accounts.map((a) => [a._id, a]));

  const credentialTypes = ["checkin", "custom", "autoreg"];
  const eligible = jobs.filter((j) => {
    const account = j.account_id != null ? accountsById.get(j.account_id) : undefined;
    // A job whose account has gone must not be scheduled with a null account and silently
    // fall back to no credentials: that is what `a.id IS NOT NULL` guarded against.
    if (j.account_id != null && !account) return false;
    if (account && account.disabled) return false;
    if (credentialTypes.includes(j.job_type)) {
      if (!account || account.auth_status !== "authenticated" || !account.session_string) {
        return false;
      }
    }
    return true;
  });

  return Promise.all(
    eligible.map(async (row) => {
      const accountRow = row.account_id != null ? accountsById.get(row.account_id) : undefined;
      const account: TgAccount | null = row.account_id != null
        ? await (async () => {
            // Credentials resolve as a pair: the account's own if complete, else global defaults
            const ownApiHash = decryptSecret(accountRow?.api_hash ?? null);
            const ownCredentials =
              accountRow?.api_id && ownApiHash
                ? { apiId: accountRow.api_id, apiHash: ownApiHash }
                : null;
            const credentials = ownCredentials ?? (await getDefaultTgApiCredentials());
            return {
              id: row.account_id as number,
              name: accountRow?.name ?? "",
              phoneNumber: accountRow?.phone_number ?? "",
              apiId: credentials?.apiId ?? 0,
              apiHash: credentials?.apiHash ?? "",
              sessionString: accountRow?.session_string ?? "",
              authStatus: accountRow?.auth_status ?? "unauthenticated",
              proxyId: accountRow?.proxy_id ?? null,
              disabled: Boolean(accountRow?.disabled),
              appClientId: accountRow?.app_client_id ?? null,
              createdAt: accountRow?.created_at ?? "",
            } as TgAccount;
          })()
        : null;

      return {
        job: {
          id: row._id,
          name: row.name,
          accountId: row.account_id ?? null,
          jobType: row.job_type as JobType,
          botUsername: row.bot_username,
          scheduleWindowStart: row.schedule_window_start,
          scheduleWindowEnd: row.schedule_window_end,
          timezone: row.timezone,
          replyTimeoutMs: row.reply_timeout_ms,
          retryMax: row.retry_max,
          enabled: Boolean(row.enabled),
          createdAt: row.created_at,
          config: row.config ?? null,
          startCommand: row.start_command || "/start",
          checkinButton: row.checkin_button || "签到",
          templateId: row.template_id ?? null,
          runEveryDays: row.run_every_days ?? 1,
          runEveryDaysMax: row.run_every_days_max ?? null,
        } as Job,
        account,
      };
    }),
  );
}

export async function executeJob(
  job: Job,
  account: TgAccount | null,
): Promise<void> {
  await acquireRunSlot();
  const detailLogs: JobDetailLog[] = [];
  let logId: number | bigint | undefined;
  try {
    // Re-fetch job settings so changes made after scheduling take effect
    const freshJob = await col<JobDoc>("jobs").findOne({ _id: job.id });
    if (freshJob) {
      job = {
        id: freshJob._id,
        name: freshJob.name,
        accountId: freshJob.account_id ?? null,
        jobType: freshJob.job_type as JobType,
        botUsername: freshJob.bot_username,
        scheduleWindowStart: freshJob.schedule_window_start,
        scheduleWindowEnd: freshJob.schedule_window_end,
        timezone: freshJob.timezone,
        replyTimeoutMs: freshJob.reply_timeout_ms,
        retryMax: freshJob.retry_max,
        enabled: Boolean(freshJob.enabled),
        createdAt: freshJob.created_at,
        config: freshJob.config ?? null,
        startCommand: freshJob.start_command || "/start",
        checkinButton: freshJob.checkin_button || "签到",
        templateId: freshJob.template_id ?? null,
        runEveryDays: freshJob.run_every_days ?? 1,
        runEveryDaysMax: freshJob.run_every_days_max ?? null,
      };
    }

    const ranAt = new Date().toISOString();
    logId = await runStarted(job.id, { source: "scheduler", message: "Scheduled" });

    const signal = registerJob(Number(logId));
    registerLiveDetail(Number(logId), detailLogs);

    // Re-fetch session in case it was updated since scheduling
    if (account) {
      const fresh = await col<AccountDoc>("tg_accounts").findOne(
        { _id: account.id },
        { projection: { session_string: 1 } },
      );
      if (fresh?.session_string)
        account = { ...account, sessionString: decryptSecret(fresh.session_string) };
    }

    await runJob(job, account, detailLogs, signal);
    const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
    // Warnings ride along with a successful run: the job completed, so failing it
    // would be wrong, but the log should say what didn't work.
    const warnings = collectRunWarnings(job.jobType, detailLogs);
    await updateLog(Number(logId), { status: "success", message: completedMessage(warnings), detail });
    if (warnings.length) console.warn(`[scheduler] "${job.name}" completed with warnings: ${warnings.join('; ')}`);
    // Durable stamp; job_logs is pruned by log_retention_days. Only moves
    // forward so a slow run finishing after a later one can't rewind it.
    // Isolated: a failure here must not demote an otherwise successful run.
    try {
      // Only moves forward, so a slow run finishing after a later one cannot rewind it.
      await col<JobDoc>("jobs").updateOne(
        {
          _id: job.id,
          $or: [{ last_success_at: null }, { last_success_at: { $lt: ranAt } }],
        },
        { $set: { last_success_at: ranAt } },
      );
    } catch (e) {
      console.warn(`[scheduler] "${job.name}" last_success_at stamp failed:`, e);
    }
    console.log(`[scheduler] "${job.name}" completed`);
    void notifyJobEvent(
      "success",
      buildSuccessMessage(job.name, job.jobType),
      account,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isCancelled = message === "Job cancelled";
    if (logId !== undefined) {
      const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
      await updateLog(Number(logId), {
        status: "failed",
        message: isCancelled ? "Cancelled" : message,
        detail,
      });
    }
    console.error(`[scheduler] "${job.name}" failed:`, message);
    if (!isCancelled) {
      void notifyJobEvent(
        "failed",
        buildFailureMessage(job.name, job.jobType, message),
        account,
      );
    }
  } finally {
    releaseRunSlot();
    if (logId !== undefined) {
      unregisterJob(Number(logId));
      clearLiveDetail(Number(logId));
    }
    // Only re-arm the timer if the job still exists and is enabled — a job
    // disabled or deleted mid-run must not reschedule itself (refreshJobs is
    // the authority and would otherwise not catch it before the next fire).
    const current = await col<JobDoc>("jobs").findOne(
      { _id: job.id },
      { projection: { enabled: 1 } },
    );
    if (current?.enabled) {
      void scheduleOne(
        job,
        account,
        await resolveRunEveryDays(job.id, job.runEveryDays ?? 1, job.runEveryDaysMax),
      );
    }
  }
}

async function scheduleOne(job: Job, account: TgAccount | null, daysAhead = 0): Promise<void> {
  const existing = schedule.get(job.id);
  if (existing) clearTimeout(existing.timer);

  // Stagger away from every other job's slot so runs don't pile into the
  // same minute (issue #10)
  const occupied = Array.from(schedule.values())
    .filter((entry) => entry.job.id !== job.id)
    .map((entry) => entry.nextRun.getTime());

  const timezone = await resolveJobTimezone(job.timezone);
  const nextRun = pickNextRun(
    job.scheduleWindowStart,
    job.scheduleWindowEnd,
    timezone,
    daysAhead,
    { occupied, gapMinutes: await getScheduleGapMinutes() },
  );
  const delayMs = Math.max(0, nextRun.toMillis() - Date.now());

  let timer!: ReturnType<typeof setTimeout>;
  armLongTimeout(
    delayMs,
    () => executeJob(job, account),
    (t) => {
      timer = t;
      const entry = schedule.get(job.id);
      if (entry) entry.timer = t;
    },
  );
  schedule.set(job.id, {
    job,
    account,
    timezone,
    nextRun: nextRun.toJSDate(),
    timer,
  });

  console.log(
    `[scheduler] "${job.name}" next run: ${nextRun.toISO()} (in ${Math.round(delayMs / 60_000)} min)`,
  );
}

async function refreshJobs(): Promise<void> {
  const eligible = await loadEligibleJobs();
  const eligibleIds = new Set(eligible.map((e) => e.job.id));

  // Remove jobs no longer eligible
  for (const [id, entry] of schedule) {
    if (!eligibleIds.has(id)) {
      clearTimeout(entry.timer);
      schedule.delete(id);
      console.log(`[scheduler] Unscheduled job ${id}`);
    }
  }

  const dailyCheckOn = await checkDailyRunEnabled();

  // Add newly eligible jobs, or re-schedule if config changed
  for (const { job, account } of eligible) {
    const existing = schedule.get(job.id);
    const resolvedTz = await resolveJobTimezone(job.timezone);
    if (!existing) {
      const daysAhead = dailyCheckOn
        ? await daysUntilNextRun(job.id, resolvedTz, job.runEveryDays ?? 1, job.runEveryDaysMax)
        : 0;
      await scheduleOne(job, account, daysAhead);
    } else {
      // Compare resolved timezones so a default_timezone change reschedules
      // jobs that follow the default
      const scheduleChanged =
        existing.job.scheduleWindowStart !== job.scheduleWindowStart ||
        existing.job.scheduleWindowEnd !== job.scheduleWindowEnd ||
        existing.timezone !== resolvedTz ||
        existing.job.botUsername !== job.botUsername ||
        existing.job.accountId !== job.accountId ||
        existing.job.runEveryDays !== job.runEveryDays ||
        existing.job.runEveryDaysMax !== job.runEveryDaysMax;
      if (scheduleChanged) {
        const daysAhead = dailyCheckOn
          ? await daysUntilNextRun(job.id, resolvedTz, job.runEveryDays ?? 1, job.runEveryDaysMax)
          : 0;
        await scheduleOne(job, account, daysAhead);
      } else {
        // Keep the timer but update the stored snapshot so status reflects current settings
        schedule.set(job.id, { ...existing, job, account });
      }
    }
  }
}

export function refreshScheduler(): void {
  void refreshJobs().catch((e) => console.error("[scheduler] refresh failed:", e));
}

/** Deletes job logs older than the configured retention window. 0 keeps everything. */
export async function purgeOldLogs(): Promise<void> {
  const days = Number((await getSetting("log_retention_days")) ?? 0);
  if (!Number.isFinite(days) || days <= 0) return;

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  // Never prune a run still in flight: `status != 'running'` in the old SQL.
  const { deletedCount } = await col("job_logs").deleteMany({
    ran_at: { $lt: cutoff },
    status: { $ne: "running" },
  });
  const changes = deletedCount ?? 0;
  if (changes > 0) {
    console.log(
      `[scheduler] Purged ${changes} job log(s) older than ${days} day(s)`,
    );
  }
}

/**
 * Mark any job_logs still in 'running' state as failed. On a fresh process
 * start nothing is actually running, so a leftover 'running' row means the
 * previous process was killed mid-run (e.g. during an upgrade), leaving the
 * log stuck and un-stoppable. (issue #18)
 */
export async function reconcileOrphanedRuns(): Promise<void> {
  const changes = await failRunningLogs("Interrupted by server restart");
  if (changes > 0) {
    console.log(`[scheduler] Marked ${changes} interrupted run(s) as failed`);
  }
}

export async function startScheduler(): Promise<void> {
  console.log("[scheduler] Starting");
  await reconcileOrphanedRuns();
  await refreshJobs();
  // Re-check every 5 minutes to pick up new/changed jobs
  setInterval(() => void refreshJobs().catch((e) => console.error("[scheduler] refresh failed:", e)), 5 * 60 * 1000);
  await purgeOldLogs();
  // Retention sweep is cheap, so hourly keeps the collection tidy without load
  setInterval(() => void purgeOldLogs().catch((e) => console.error("[scheduler] purge failed:", e)), 60 * 60 * 1000);
}

export function getSchedulerStatus(): Array<{
  jobId: number;
  jobName: string;
  jobType: string;
  nextRun: string;
}> {
  return Array.from(schedule.values()).map(({ job, nextRun }) => ({
    jobId: job.id,
    jobName: job.name,
    jobType: job.jobType,
    nextRun: nextRun.toISOString(),
  }));
}

/**
 * Drops a job's pending run and arms the one after it, which is how an operator calls off a
 * run they can see coming without disabling the job. The job keeps its schedule; only this
 * occurrence is given up, so the list shows it again on its next eligible day.
 */
export async function skipNextRun(
  jobId: number,
): Promise<{ ok: boolean; nextRun?: string }> {
  const entry = schedule.get(jobId);
  if (!entry) return { ok: false };

  // Counted from the pending run's own day, not from today: that run may already be days out
  // (its window has passed today), and a day counted from today would land on or before it --
  // rescheduling the very run being called off, sometimes to an earlier minute.
  const pendingDay = DateTime.fromJSDate(entry.nextRun)
    .setZone(entry.timezone)
    .startOf("day");
  const today = DateTime.now().setZone(entry.timezone).startOf("day");
  const daysUntilPending = Math.max(0, Math.round(pendingDay.diff(today, "days").days));

  // Past that day, the next opportunity is one interval on -- one day for a daily job
  const interval = (await checkDailyRunEnabled())
    ? Math.max(
        1,
        await resolveRunEveryDays(jobId, entry.job.runEveryDays ?? 1, entry.job.runEveryDaysMax),
      )
    : 1;
  const daysAhead = daysUntilPending + interval;

  await scheduleOne(entry.job, entry.account, daysAhead);
  const nextRun = schedule.get(jobId)?.nextRun.toISOString();
  console.log(`[scheduler] "${entry.job.name}" run skipped by operator; next run: ${nextRun}`);
  return { ok: true, nextRun };
}
