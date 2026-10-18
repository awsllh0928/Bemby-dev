// Jobs with an empty timezone follow the default_timezone setting at
// scheduling time, so changing the default reschedules them (issue #13).

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
import { DateTime } from "luxon";
import {
  refreshScheduler,
  getSchedulerStatus,
  resolveJobTimezone,
} from "../scheduler";
import { setSetting } from "../db/repos/settings";
import { insert, jobDoc, useTestDb } from "./helpers/db";
import { waitUntil } from "./helpers/async";

const FALLBACK = "Australia/Sydney";

// The window these tests assert on is 01:00-03:00 in the job's own zone.
const WINDOW_START = 100;
const WINDOW_END = 300;

async function insertJob(timezone = ""): Promise<number> {
  const id = 1;
  await insert("jobs", [
    jobDoc({
      _id: id,
      job_type: "embywatch",
      timezone,
      schedule_window_start: WINDOW_START,
      schedule_window_end: WINDOW_END,
    }),
  ]);
  return id;
}

/**
 * refreshScheduler is fire-and-forget by design -- the routes must not wait on a reschedule --
 * so a test has to observe the result rather than the call. Waiting for the schedule to hold
 * the expected number of jobs is that observation.
 */
async function refreshAndWaitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  refreshScheduler();
  await waitUntil(predicate, label);
}

/** Waits for the schedule to hold `expected` jobs. Only usable when it does not already. */
async function refreshAndWait(expected: number): Promise<void> {
  await refreshAndWaitFor(
    () => getSchedulerStatus().length === expected,
    `${expected} 个任务进入调度表`,
  );
}

function nextRunIn(zone: string): DateTime {
  const status = getSchedulerStatus();
  expect(status).toHaveLength(1);
  return DateTime.fromISO(status[0].nextRun, { zone });
}

useTestDb();

beforeEach(async () => {
  // `shouldAdvanceTime` matters: the clock is faked so `pickNextRun` sees a fixed "now", but
  // waiting on the store still needs timers that fire -- `waitUntil` polls with setTimeout.
  // Without this the fake clock stands still and the poll never resumes.
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 5 });
  // 08:00 UTC = 16:00 in Hong Kong, past the 01:00-03:00 window
  vi.setSystemTime(new Date("2024-06-15T08:00:00Z"));

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

describe("resolveJobTimezone", () => {
  it("returns the job's own zone when set and valid", async () => {
    expect(await resolveJobTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("falls back to the default for empty or invalid zones", async () => {
    await setSetting("default_timezone", "Asia/Hong_Kong");
    expect(await resolveJobTimezone("")).toBe("Asia/Hong_Kong");
    expect(await resolveJobTimezone(null)).toBe("Asia/Hong_Kong");
    expect(await resolveJobTimezone("Not/AZone")).toBe("Asia/Hong_Kong");
  });

  it("uses the built-in fallback when the default itself is invalid", async () => {
    await setSetting("default_timezone", "garbage");
    expect(await resolveJobTimezone("")).toBe(FALLBACK);
  });
});

describe("default timezone scheduling", () => {
  it("schedules a follow-default job in the default zone's window", async () => {
    await setSetting("default_timezone", "Asia/Hong_Kong");
    await insertJob();
    await refreshAndWait(1);

    const next = nextRunIn("Asia/Hong_Kong");
    expect(next.hour).toBeGreaterThanOrEqual(1);
    expect(next.hour).toBeLessThan(3);
    // Window already passed today in HK, so it lands tomorrow
    expect(next.toISODate()).toBe("2024-06-16");
  });

  it("reschedules follow-default jobs when the default changes", async () => {
    await setSetting("default_timezone", "Asia/Hong_Kong");
    await insertJob();
    await refreshAndWait(1);
    // Watch the raw nextRun, not a count: the entry is already there, so waiting for one job
    // would return before the reschedule had happened.
    const beforeRun = getSchedulerStatus()[0].nextRun;
    const before = DateTime.fromISO(beforeRun, { zone: "Asia/Hong_Kong" });

    await setSetting("default_timezone", "America/New_York");
    await refreshAndWaitFor(
      () => getSchedulerStatus()[0]?.nextRun !== beforeRun,
      "默认时区变更后重新排期",
    );

    const next = nextRunIn("America/New_York");
    expect(next.toMillis()).not.toBe(before.toMillis());
    expect(next.hour).toBeGreaterThanOrEqual(1);
    expect(next.hour).toBeLessThan(3);
  });

  it("leaves jobs with an explicit timezone untouched by a default change", async () => {
    await setSetting("default_timezone", "Asia/Hong_Kong");
    await insertJob("Asia/Tokyo");
    await refreshAndWait(1);
    const before = nextRunIn("Asia/Tokyo");
    expect(before.hour).toBeGreaterThanOrEqual(1);
    expect(before.hour).toBeLessThan(3);

    await setSetting("default_timezone", "America/New_York");
    await refreshAndWait(1);

    expect(nextRunIn("Asia/Tokyo").toMillis()).toBe(before.toMillis());
  });

  it("schedules an invalid job timezone in the default zone instead of breaking", async () => {
    await setSetting("default_timezone", "UTC");
    await insertJob("Not/AZone");
    await refreshAndWait(1);

    const next = nextRunIn("UTC");
    expect(next.isValid).toBe(true);
    expect(next.hour).toBeGreaterThanOrEqual(1);
    expect(next.hour).toBeLessThan(3);
  });
});
