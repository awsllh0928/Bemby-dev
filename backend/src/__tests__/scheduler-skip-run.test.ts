vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/cancellation", () => ({
  registerJob: vi.fn().mockReturnValue(new AbortController().signal),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock("../jobs/notify", () => ({
  getNotifyConfig: vi.fn().mockResolvedValue({ events: [], username: null }),
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildSuccessMessage: vi.fn(),
  buildFailureMessage: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { refreshScheduler, getSchedulerStatus, skipNextRun } from "../scheduler";
import { setSetting } from "../db/repos/settings";
import { dump, insert, accountDoc, jobDoc, useTestDb } from "./helpers/db";
import { pause, waitUntil } from "./helpers/async";

// 08:00 UTC, before the default 10:00-12:00 window, so every job has a run coming today
const BASE_DATE = "2024-06-15";
const TZ = "UTC";
const BASE_NOW = Date.parse(`${BASE_DATE}T08:00:00Z`);

const ACCOUNT_ID = 100;

let nextJobId = 0;

/** checkin/custom/autoreg jobs are only eligible with an authenticated account behind them */
async function insertAccount(): Promise<void> {
  await insert("tg_accounts", [
    accountDoc({
      _id: ACCOUNT_ID,
      name: "acct",
      api_id: 1,
      api_hash: "hash",
      session_string: "session",
      auth_status: "authenticated",
    }),
  ]);
}

async function insertJob(
  name: string,
  jobType = "checkin",
  window?: { start: number; end: number },
  runEveryDays?: number,
): Promise<number> {
  const id = ++nextJobId;
  await insert("jobs", [
    jobDoc({
      _id: id,
      name,
      job_type: jobType,
      account_id: ACCOUNT_ID,
      timezone: TZ,
      schedule_window_start: window?.start ?? 1000,
      schedule_window_end: window?.end ?? 1200,
      ...(runEveryDays === undefined ? {} : { run_every_days: runEveryDays }),
    }),
  ]);
  return id;
}

const nextRunOf = (id: number) =>
  getSchedulerStatus().find((s) => s.jobId === id)!.nextRun;

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

useTestDb();

beforeEach(async () => {
  // `shouldAdvanceTime`: the clock is faked so `pickNextRun` sees a fixed "now", but waiting
  // on the store still needs timers that fire -- `waitUntil` polls with setTimeout.
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 5 });
  vi.setSystemTime(new Date(BASE_NOW));

  nextJobId = 0;
  await insertAccount();
  await setSetting("check_daily_run", "true");

  // Drop whatever the previous test left in the schedule. The database is already empty at
  // this point, so a refresh sees no eligible job and removes every entry.
  refreshScheduler();
  await waitUntil(() => getSchedulerStatus().length === 0, "调度表清空");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getSchedulerStatus", () => {
  it("reports each job's type, which is what the list colours the chips by", async () => {
    await insertJob("Checkin job", "checkin");
    await insertJob("Watch job", "embywatch");
    await insertJob("Custom job", "custom");
    await insertJob("Signup job", "autoreg");
    await refreshAndWait(4);

    const byName = Object.fromEntries(
      getSchedulerStatus().map((s) => [s.jobName, s.jobType]),
    );
    expect(byName).toEqual({
      "Checkin job": "checkin",
      "Watch job": "embywatch",
      "Custom job": "custom",
      "Signup job": "autoreg",
    });
  });
});

describe("skipNextRun", () => {
  it("moves the pending run to a later day and keeps the job scheduled", async () => {
    const id = await insertJob("Daily job");
    await refreshAndWait(1);
    const before = nextRunOf(id);

    const result = await skipNextRun(id);

    expect(result.ok).toBe(true);
    const after = nextRunOf(id);
    expect(after).toBe(result.nextRun);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    // A day out, not merely a later slot in today's window
    expect(new Date(after).getUTCDate()).toBeGreaterThan(new Date(before).getUTCDate());
  });

  it("leaves the job in the list rather than unscheduling it", async () => {
    const id = await insertJob("Daily job");
    await refreshAndWait(1);

    await skipNextRun(id);

    expect(getSchedulerStatus().map((s) => s.jobId)).toContain(id);
  });

  it("does not fire the run that was called off", async () => {
    const id = await insertJob("Daily job");
    await refreshAndWait(1);
    const firesAt = new Date(nextRunOf(id)).getTime();

    await skipNextRun(id);

    // Past the original slot: nothing should have run, and the entry still stands
    vi.setSystemTime(new Date(firesAt + 60_000));
    vi.advanceTimersByTime(firesAt + 60_000 - BASE_NOW);
    // executeJob would write its log asynchronously, so give it the chance to before
    // asserting that it did not.
    await pause(100);
    expect(await dump("job_logs")).toEqual([]);
  });

  it("leaves other jobs' runs alone", async () => {
    const a = await insertJob("Job A");
    const b = await insertJob("Job B");
    await refreshAndWait(2);
    const bBefore = nextRunOf(b);

    await skipNextRun(a);

    expect(nextRunOf(b)).toBe(bBefore);
  });

  it("moves a run that is already days out further still, never nearer", async () => {
    // Window is behind us today, so the pending run is already tomorrow. Counting a day from
    // today would land back on that same day -- possibly at an earlier minute.
    const id = await insertJob("Evening job", "checkin", { start: 300, end: 500 });
    await refreshAndWait(1);
    const before = nextRunOf(id);
    expect(new Date(before).getUTCDate()).toBe(16); // tomorrow

    await skipNextRun(id);

    const after = nextRunOf(id);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(new Date(after).getUTCDate()).toBe(17);
  });

  it("skips a whole interval for a job that does not run daily", async () => {
    const id = await insertJob("Every third day", "checkin", undefined, 3);
    await refreshAndWait(1);
    const before = nextRunOf(id);

    await skipNextRun(id);

    const after = nextRunOf(id);
    const days =
      (new Date(after).setUTCHours(0, 0, 0, 0) - new Date(before).setUTCHours(0, 0, 0, 0)) /
      86_400_000;
    expect(days).toBe(3);
  });

  it("reports a job that has no scheduled run rather than throwing", async () => {
    expect(await skipNextRun(4242)).toEqual({ ok: false });
  });
});
