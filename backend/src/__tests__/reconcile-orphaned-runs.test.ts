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
import { reconcileOrphanedRuns } from "../scheduler";
import { dump, insert, useTestDb } from "./helpers/db";
import type { JobLogDoc } from "../db/types";

// What used to be checked by matching an UPDATE statement's text is now checked against the
// rows: a log left `running` by a process that died has to come back `failed`.
useTestDb();

async function logs(): Promise<JobLogDoc[]> {
  return dump<JobLogDoc>("job_logs");
}

describe("reconcileOrphanedRuns — stuck running logs (issue #18)", () => {
  beforeEach(async () => {
    await insert("job_logs", [
      { _id: 1, job_id: 7, ran_at: "2024-01-01T00:00:00Z", status: "running", message: null },
      { _id: 2, job_id: 8, ran_at: "2024-01-02T00:00:00Z", status: "success", message: "ok" },
    ]);
  });

  it("marks leftover 'running' logs as failed", async () => {
    await reconcileOrphanedRuns();

    const left = await logs();
    expect(left.find((l) => l._id === 1)?.status).toBe("failed");
    // A log that finished keeps the status it had
    expect(left.find((l) => l._id === 2)?.status).toBe("success");
  });

  it("says a run was interrupted rather than leaving no message at all", async () => {
    await reconcileOrphanedRuns();
    const message = (await logs()).find((l) => l._id === 1)?.message;
    expect(message).toBeTruthy();
  });
});
