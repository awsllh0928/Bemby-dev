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
  buildSuccessMessage: vi.fn().mockReturnValue("ok"),
  buildFailureMessage: vi.fn().mockReturnValue("fail"),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeJob } from "../scheduler";
import { runJob } from "../jobs/runner";
import { dump, useTestDb } from "./helpers/db";
import type { JobLogDoc } from "../db/types";
import type { Job, TgAccount } from "../types";

// The run log is a collection now, so instead of inspecting SQL strings handed to a mocked
// `prepare` these read the rows back out and assert on those.
useTestDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const job: Job = {
  id: 7,
  name: "Logging Test Job",
  accountId: 1,
  jobType: "checkin",
  botUsername: "@bot",
  scheduleWindowStart: 1000,
  scheduleWindowEnd: 1200,
  timezone: "UTC",
  replyTimeoutMs: 5000,
  retryMax: 1,
  enabled: true,
  createdAt: "2024-01-01T00:00:00Z",
  config: null,
  startCommand: "/start",
  checkinButton: "签到",
  runEveryDays: 1,
};

const account: TgAccount = {
  id: 1,
  name: "Acct",
  phoneNumber: "+1",
  apiId: 1,
  apiHash: "hash",
  sessionString: "session",
  authStatus: "authenticated",
  proxyId: null,
  disabled: false,
  appClientId: null,
  createdAt: "2024-01-01T00:00:00Z",
};

async function logs(): Promise<JobLogDoc[]> {
  return dump<JobLogDoc>("job_logs");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeJob — DB status logging", () => {
  // runJob is mocked to resolve immediately, so executeJob completes without
  // needing any timer advancement. scheduleOne creates a far-future timer
  // that never fires during the test.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runJob).mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clear any lingering timers from scheduleOne's finally block
    vi.clearAllTimers();
  });

  it("inserts a job_log row with the job id before executing", async () => {
    await executeJob(job, null);
    const written = await logs();
    expect(written).toHaveLength(1);
    expect(written[0].job_id).toBe(job.id);
    expect(Date.parse(written[0].ran_at)).not.toBeNaN();
  });

  it("updates status to 'success' after runJob resolves", async () => {
    await executeJob(job, null);
    expect((await logs())[0].status).toBe("success");
  });

  it("stores serialised detail logs in the success update", async () => {
    vi.mocked(runJob).mockImplementation(async (_job, _account, detailLogs) => {
      detailLogs?.push({ attempt: 1, commandSent: "/start" } as any);
    });

    await executeJob(job, null);

    const written = (await logs())[0];
    expect(written.detail).toBeTruthy();
    expect(JSON.parse(written.detail!)[0]).toMatchObject({
      attempt: 1,
      commandSent: "/start",
    });
  });

  it("updates status to 'failed' when runJob throws", async () => {
    vi.mocked(runJob).mockRejectedValue(new Error("bot is down"));
    await executeJob(job, null).catch(() => {});
    expect((await logs())[0].status).toBe("failed");
  });

  it("stores the error message in the failed update", async () => {
    vi.mocked(runJob).mockRejectedValue(new Error("connection refused"));
    await executeJob(job, null).catch(() => {});
    expect((await logs())[0].message).toBe("connection refused");
  });

  it("marks the run as 'Cancelled' when the job is cancelled", async () => {
    vi.mocked(runJob).mockRejectedValue(new Error("Job cancelled"));
    await executeJob(job, account).catch(() => {});
    expect((await logs())[0].message).toBe("Cancelled");
  });
});
