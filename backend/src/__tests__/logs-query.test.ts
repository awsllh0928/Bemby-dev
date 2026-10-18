// GET /logs query hardening: limit clamped to 200, offset floored at 0,
// jobId validated as a positive integer.

vi.mock("../jobs/cancellation", () => ({
  cancelJob: vi.fn(),
  isJobRunning: vi.fn().mockReturnValue(false),
  getLiveDetail: vi.fn().mockReturnValue(null),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import logsRouter from "../routes/logs";
import { insert, jobDoc, logDoc, useTestDb } from "./helpers/db";

const JOB_ID = 1;
const LOG_COUNT = 250;

function routeHandler(method: string, path: string) {
  const layer = (logsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle as (req: any, res: any) => Promise<void>;
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

async function list(query: Record<string, string>) {
  const res = makeRes();
  // The handler awaits the repositories now, so the response is only filled in afterwards.
  await routeHandler("get", "/")({ query }, res);
  return res;
}

// Enough rows that the 200-row clamp and the 50-row default are both observable.
useTestDb();

beforeEach(async () => {
  await insert("jobs", [jobDoc({ _id: JOB_ID, name: "Job A" })]);
  await insert(
    "job_logs",
    Array.from({ length: LOG_COUNT }, (_, i) =>
      logDoc({
        _id: i + 1,
        job_id: JOB_ID,
        ran_at: `2024-06-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
      }),
    ),
  );
});

describe("GET /logs query hardening", () => {
  it("defaults to 50 rows", async () => {
    expect((await list({})).body).toHaveLength(50);
  });

  it("clamps limit to 200", async () => {
    expect((await list({ limit: "999999" })).body).toHaveLength(200);
  });

  it("falls back to the default on a non-numeric limit", async () => {
    expect((await list({ limit: "abc" })).body).toHaveLength(50);
  });

  it("floors a negative offset to 0", async () => {
    const res = await list({ offset: "-5", limit: "10" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(10);
  });

  it("rejects a non-numeric jobId", async () => {
    const res = await list({ jobId: "abc" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid jobId");
  });

  it("rejects a non-positive jobId", async () => {
    expect((await list({ jobId: "0" })).statusCode).toBe(400);
    expect((await list({ jobId: "-3" })).statusCode).toBe(400);
  });

  it("accepts a valid jobId", async () => {
    const res = await list({ jobId: "1", limit: "5" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(5);
    expect(res.body[0].jobId).toBe(1);
  });
});
