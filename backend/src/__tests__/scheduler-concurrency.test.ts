let releaseRun: Array<() => void> = [];

// Each runJob call blocks until its release function is invoked
vi.mock("../jobs/runner", () => ({
  runJob: vi.fn(
    () => new Promise<void>((resolve) => releaseRun.push(resolve)),
  ),
}));
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
import { executeJob } from "../scheduler";
import { runJob } from "../jobs/runner";
import { dump, insert, jobDoc, useTestDb } from "./helpers/db";
import { pause, waitUntil } from "./helpers/async";
import type { JobLogDoc } from "../db/types";
import type { Job } from "../types";

const JOB_IDS = [1, 2, 3];

// executeJob re-reads the job, so the rows have to exist for it to rebuild a full Job.
useTestDb();

const runJobCalls = () => vi.mocked(runJob).mock.calls.length;

let pending: Array<Promise<void>> = [];

function start(id: number): Promise<void> {
  const p = executeJob({ id } as Job, null);
  pending.push(p);
  return p;
}

const startAll = () => JOB_IDS.map(start);

async function logStatuses(): Promise<string[]> {
  const rows = await dump<JobLogDoc>("job_logs");
  return rows.sort((a, b) => a._id - b._id).map((r) => r.status);
}

beforeEach(async () => {
  releaseRun = [];
  pending = [];
  vi.mocked(runJob).mockClear();
  await insert("jobs", JOB_IDS.map((id) => jobDoc({ _id: id, job_type: "embywatch" })));
});

afterEach(async () => {
  // Release whatever is still holding a slot, then wait for every run to finish. A failing
  // assertion would otherwise leave an executeJob suspended until afterAll drops the database,
  // and its `finally` block would then query a connection that is already closed.
  //
  // It has to loop: freeing a slot lets the queued job start, and that job registers a release
  // function of its own a round trip later -- long after the pass that freed it looked.
  for (let pass = 0; pass < 10; pass++) {
    releaseRun.forEach((release) => release());
    releaseRun = [];
    const settled = await Promise.race([
      Promise.allSettled(pending).then(() => true as const),
      pause(50).then(() => false as const),
    ]);
    if (settled) break;
  }
  pending = [];
  // executeJob deliberately does not await scheduleOne, so that is still in flight here.
  // Give it a moment rather than let afterAll pull the connection out from under it.
  await pause(150);
});

describe("job execution concurrency cap", () => {
  it("runs at most 2 jobs at once and queues the rest", async () => {
    startAll();
    await waitUntil(() => runJobCalls() === 2, "两个任务开始运行");

    // The third must not sneak into a slot of its own.
    await pause(150);
    expect(runJob).toHaveBeenCalledTimes(2);

    releaseRun[0]();
    await waitUntil(() => runJobCalls() === 3, "排队任务获得空出的槽位");
    expect(runJob).toHaveBeenCalledTimes(3);
  });

  it("does not create the run log until a slot is acquired", async () => {
    startAll();
    await waitUntil(async () => (await logStatuses()).length === 2, "两个运行中的任务写日志");

    // Only the two running jobs have log rows; the queued one has none yet.
    await pause(150);
    expect(await logStatuses()).toHaveLength(2);
  });

  it("frees the slot when a job fails", async () => {
    vi.mocked(runJob).mockRejectedValueOnce(new Error("boom"));

    start(1);
    await waitUntil(() => runJobCalls() === 1, "失败任务到达 runJob");

    // j1 failed immediately, so its slot was released and these two both got one.
    start(2);
    start(3);
    await waitUntil(() => runJobCalls() === 3, "三个任务都运行过");
    expect(runJob).toHaveBeenCalledTimes(3);
  });
});
