// Regression test for the account-deletion guard (routes/accounts.ts DELETE /:id).
//
// checkin/custom jobs can't run without their linked tg_accounts row. Before this
// fix, deleting the account silently set the job's account_id to NULL (via the
// jobs.account_id ON DELETE SET NULL foreign key), permanently dropping the job
// out of the scheduler with no warning — while embywatch jobs, which don't need
// an account, kept working. This made it look like "only Emby Watch jobs run".
//
// The guard is now a query for jobs pointing at the account; Mongo has no foreign keys, so
// there is nothing left to cascade and the check is the only thing standing between a
// delete and a job that quietly stops running.

import http from "http";
import express from "express";

const refreshScheduler = vi.fn();

vi.mock("../scheduler", () => ({ refreshScheduler }));
vi.mock("../auth/tgAuth", () => ({
  requestCode: vi.fn(),
  submitCode: vi.fn(),
  submitPassword: vi.fn(),
  checkAccountStatus: vi.fn(),
  resendCodeAsSms: vi.fn(),
  updateTwoFa: vi.fn(),
  getSessions: vi.fn(),
  terminateSession: vi.fn(),
  terminateOtherSessions: vi.fn(),
}));
vi.mock("../jobs/checkin", () => ({ checkSpamStatus: vi.fn() }));
vi.mock("../jobs/runner", () => ({ parseTgProxy: vi.fn() }));
vi.mock("../tg/liveClient", () => ({
  isAuthError: vi.fn(),
  markSessionExpired: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { getAccount } from "../db/repos/accounts";
import { accountDoc, insert, jobDoc, useTestDb } from "./helpers/db";

const ACCOUNT_ID = 1;
const JOB_ID = 1;

async function insertAccount(): Promise<number> {
  await insert("tg_accounts", [accountDoc({ _id: ACCOUNT_ID })]);
  return ACCOUNT_ID;
}

async function insertJob(
  accountId: number | null,
  jobType: string,
  name = "Job",
): Promise<number> {
  await insert("jobs", [jobDoc({ _id: JOB_ID, name, account_id: accountId, job_type: jobType })]);
  return JOB_ID;
}

const accountStillThere = async (id: number) => (await getAccount(id)) !== null;

let server: http.Server;
let baseUrl: string;

useTestDb();

beforeAll(async () => {
  const { default: accountsRouter } = await import("../routes/accounts");
  const app = express();
  app.use(express.json());
  app.use("/accounts", accountsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /accounts/:id — linked job guard", () => {
  it("blocks deletion when a checkin job still depends on the account", async () => {
    const accountId = await insertAccount();
    await insertJob(accountId, "checkin", "My Checkin");

    const res = await fetch(`${baseUrl}/accounts/${accountId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("My Checkin");
    expect(await accountStillThere(accountId)).toBe(true);
    expect(refreshScheduler).not.toHaveBeenCalled();
  });

  it("blocks deletion when a custom job still depends on the account", async () => {
    const accountId = await insertAccount();
    await insertJob(accountId, "custom", "My Custom Job");

    const res = await fetch(`${baseUrl}/accounts/${accountId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(400);
    expect(await accountStillThere(accountId)).toBe(true);
  });

  it("allows deletion when the account has no linked jobs", async () => {
    const accountId = await insertAccount();

    const res = await fetch(`${baseUrl}/accounts/${accountId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    expect(await accountStillThere(accountId)).toBe(false);
    expect(refreshScheduler).toHaveBeenCalledTimes(1);
  });

  it("allows deletion when the account is only linked to an embywatch job", async () => {
    const accountId = await insertAccount();
    await insertJob(accountId, "embywatch", "Watch job");

    const res = await fetch(`${baseUrl}/accounts/${accountId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    expect(await accountStillThere(accountId)).toBe(false);
  });
});
