vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/cancellation", () => ({
  registerJob: vi.fn(),
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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { purgeOldLogs } from "../scheduler";
import { setSetting } from "../db/repos/settings";
import { dump, insert, useTestDb } from "./helpers/db";
import type { JobLogDoc } from "../db/types";

const DAY_MS = 86_400_000;

// Retention is a setting and the purge is a delete against the job_logs collection, so this
// seeds real rows instead of watching which SQL a mocked prepare() was handed.
useTestDb();

const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

async function logs(): Promise<JobLogDoc[]> {
  return dump<JobLogDoc>("job_logs");
}

beforeEach(async () => {
  await insert("job_logs", [
    { _id: 1, job_id: 7, ran_at: iso(60 * DAY_MS), status: "success", message: "old" },
    { _id: 2, job_id: 7, ran_at: iso(2 * DAY_MS), status: "success", message: "recent" },
    { _id: 3, job_id: 8, ran_at: iso(60 * DAY_MS), status: "running", message: "in flight" },
  ]);
});

describe("purgeOldLogs — log retention", () => {
  it("keeps all logs when retention is 0", async () => {
    await setSetting("log_retention_days", "0");
    await purgeOldLogs();
    expect(await logs()).toHaveLength(3);
  });

  it("keeps all logs when the setting is missing", async () => {
    await purgeOldLogs();
    expect(await logs()).toHaveLength(3);
  });

  it("keeps all logs when the setting is not a number", async () => {
    await setSetting("log_retention_days", "abc");
    await purgeOldLogs();
    expect(await logs()).toHaveLength(3);
  });

  it("keeps all logs when retention is negative", async () => {
    await setSetting("log_retention_days", "-5");
    await purgeOldLogs();
    expect(await logs()).toHaveLength(3);
  });

  it("deletes logs older than the retention window", async () => {
    await setSetting("log_retention_days", "30");
    await purgeOldLogs();

    const left = await logs();
    // The 60-day-old success is gone; the 2-day-old one and the running one remain.
    expect(left.map((l) => l._id).sort()).toEqual([2, 3]);
  });

  it("never deletes logs for jobs that are still running", async () => {
    await setSetting("log_retention_days", "1");
    await purgeOldLogs();

    const left = await logs();
    expect(left.map((l) => l._id)).toEqual([3]);
    expect(left[0].status).toBe("running");
  });
});
