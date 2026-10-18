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

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  refreshScheduler,
  getSchedulerStatus,
  getScheduleGapMinutes,
  DEFAULT_SCHEDULE_GAP_MINUTES,
} from "../scheduler";
import { deleteSetting, setSetting } from "../db/repos/settings";
import { insert, jobDoc, useTestDb } from "./helpers/db";
import { waitUntil } from "./helpers/async";

// Tests run at 08:00 UTC, before the default 10:00-12:00 window.
const BASE_DATE = "2024-06-15";
const TZ = "UTC";

const WINDOW_START = 1000;
const WINDOW_END = 1200;

async function insertJobs(
  count: number,
  window?: { scheduleWindowStart: number; scheduleWindowEnd: number },
): Promise<void> {
  await insert(
    "jobs",
    Array.from({ length: count }, (_, i) =>
      jobDoc({
        _id: i + 1,
        job_type: "embywatch",
        timezone: TZ,
        schedule_window_start: window?.scheduleWindowStart ?? WINDOW_START,
        schedule_window_end: window?.scheduleWindowEnd ?? WINDOW_END,
      }),
    ),
  );
}

async function setGap(value: string | null): Promise<void> {
  if (value == null) await deleteSetting("schedule_min_gap_minutes");
  else await setSetting("schedule_min_gap_minutes", value);
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

const nextRuns = () => getSchedulerStatus().map((s) => s.nextRun);

useTestDb();

beforeEach(async () => {
  // `shouldAdvanceTime`: the clock is faked so `pickNextRun` sees a fixed "now", but waiting
  // on the store still needs timers that fire -- `waitUntil` polls with setTimeout.
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 5 });
  vi.setSystemTime(new Date(`${BASE_DATE}T08:00:00Z`));

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

// ─── getScheduleGapMinutes ───────────────────────────────────────────────────

describe("getScheduleGapMinutes", () => {
  it("returns the default when the setting is missing", async () => {
    await setGap(null);
    expect(await getScheduleGapMinutes()).toBe(DEFAULT_SCHEDULE_GAP_MINUTES);
  });

  it("returns the stored value", async () => {
    await setGap("5");
    expect(await getScheduleGapMinutes()).toBe(5);
  });

  it("allows 0 to disable staggering", async () => {
    await setGap("0");
    expect(await getScheduleGapMinutes()).toBe(0);
  });

  it("clamps to the 0-30 range and floors fractions", async () => {
    await setGap("99");
    expect(await getScheduleGapMinutes()).toBe(30);
    await setGap("-3");
    expect(await getScheduleGapMinutes()).toBe(0);
    await setGap("4.7");
    expect(await getScheduleGapMinutes()).toBe(4);
  });

  it("returns the default for non-numeric or empty values", async () => {
    await setGap("abc");
    expect(await getScheduleGapMinutes()).toBe(DEFAULT_SCHEDULE_GAP_MINUTES);
    await setGap("");
    expect(await getScheduleGapMinutes()).toBe(DEFAULT_SCHEDULE_GAP_MINUTES);
  });
});

// ─── Staggered scheduling ────────────────────────────────────────────────────

describe("staggered scheduling", () => {
  it("keeps jobs sharing a window at least the gap apart", async () => {
    await setGap("2");
    await insertJobs(5);
    await refreshAndWait(5);

    const times = nextRuns().map((t) => new Date(t).getTime());
    expect(times).toHaveLength(5);
    for (let i = 0; i < times.length; i++) {
      for (let j = i + 1; j < times.length; j++) {
        expect(Math.abs(times[i] - times[j])).toBeGreaterThanOrEqual(
          2 * 60_000,
        );
      }
    }
  });

  it("never doubles up a minute while free minutes remain, even in a tight window", async () => {
    await setGap("2");
    // 5 jobs in a 5-minute window -- the gap is unsatisfiable, but each job
    // should still land on its own minute
    await insertJobs(5, { scheduleWindowStart: 1000, scheduleWindowEnd: 1005 });
    await refreshAndWait(5);

    const times = nextRuns();
    expect(times).toHaveLength(5);
    expect(new Set(times).size).toBe(5);
  });

  it("gap 0 disables staggering entirely", async () => {
    await setGap("0");
    vi.spyOn(Math, "random").mockReturnValue(0); // every pick lands on window start
    await insertJobs(3);
    await refreshAndWait(3);

    const times = nextRuns();
    expect(times).toHaveLength(3);
    expect(new Set(times).size).toBe(1); // all collide on 10:00, by design
  });
});
