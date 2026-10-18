// Global TG API credential fallback: credentials must resolve as a pair --
// the account's own when complete, otherwise the global defaults -- and the
// manual-run route must apply the same fallback the scheduler does.

vi.mock("../jobs/runner", () => ({ runJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../jobs/cancellation", () => ({
  registerJob: vi.fn().mockReturnValue(new AbortController().signal),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock("../jobs/notify", () => ({
  getNotifyConfig: vi.fn().mockReturnValue({ events: [], username: null }),
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildSuccessMessage: vi.fn(),
  buildFailureMessage: vi.fn(),
}));
vi.mock("../jobs/embywatch", () => ({ testEmbyConnection: vi.fn() }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadEligibleJobs } from "../scheduler";
import jobsRouter from "../routes/jobs";
import { runJob } from "../jobs/runner";
import { createAccount } from "../db/repos/accounts";
import { deleteSetting, setSetting } from "../db/repos/settings";
import { insert, jobDoc, useTestDb } from "./helpers/db";

const JOB_ID = 1;

type Creds = { apiId: number; apiHash: string } | null;

/**
 * The global pair lives in settings now, so "the operator configured a fallback" is two
 * setting writes rather than a mocked function. That also means this exercises the real
 * resolution -- including the rule that a present api_id with a missing hash is no pair.
 */
async function setDefaultCreds(creds: Creds): Promise<void> {
  if (!creds) {
    await deleteSetting("default_tg_api_id");
    await deleteSetting("default_tg_api_hash");
    return;
  }
  await setSetting("default_tg_api_id", String(creds.apiId));
  await setSetting("default_tg_api_hash", creds.apiHash);
}

async function insertAccount(apiId: number | null, apiHash: string | null): Promise<number> {
  return createAccount({
    name: "acc",
    phone_number: "+10000000000",
    api_id: apiId,
    api_hash: apiHash,
    session_string: "session",
    auth_status: "authenticated",
  });
}

async function insertCheckinJob(accountId: number): Promise<number> {
  await insert("jobs", [jobDoc({ _id: JOB_ID, job_type: "checkin", account_id: accountId })]);
  return JOB_ID;
}

/** Pulls a route handler out of the Express router so it can be called directly. */
function routeHandler(method: string, path: string) {
  const layer = (jobsRouter as any).stack.find(
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

useTestDb();

beforeEach(async () => {
  await setDefaultCreds(null);
  vi.mocked(runJob).mockClear();
});

// ─── loadEligibleJobs credential pairing ─────────────────────────────────────

describe("loadEligibleJobs credential pairing", () => {
  it("keeps the account's own pair when complete, even with defaults set", async () => {
    await setDefaultCreds({ apiId: 999, apiHash: "global-hash" });
    await insertCheckinJob(await insertAccount(111, "own-hash"));

    const [{ account }] = await loadEligibleJobs();
    expect(account?.apiId).toBe(111);
    expect(account?.apiHash).toBe("own-hash");
  });

  it("uses the full global pair when the account pair is incomplete", async () => {
    await setDefaultCreds({ apiId: 999, apiHash: "global-hash" });
    // api_id set but no hash -- must NOT mix own id with global hash
    await insertCheckinJob(await insertAccount(111, null));

    const [{ account }] = await loadEligibleJobs();
    expect(account?.apiId).toBe(999);
    expect(account?.apiHash).toBe("global-hash");
  });

  it("treats 0 / empty-string credentials as missing", async () => {
    await setDefaultCreds({ apiId: 999, apiHash: "global-hash" });
    await insertCheckinJob(await insertAccount(0, ""));

    const [{ account }] = await loadEligibleJobs();
    expect(account?.apiId).toBe(999);
    expect(account?.apiHash).toBe("global-hash");
  });

  it("resolves to empty credentials when neither account nor global credentials exist", async () => {
    await insertCheckinJob(await insertAccount(null, null));

    const [{ account }] = await loadEligibleJobs();
    // `TgAccount.apiId` is a plain number, so "no credentials" is 0 / "" rather than the
    // NULL the old joined row carried. Every consumer tests truthiness, so this is the same
    // answer wearing the type's clothes.
    expect(account?.apiId).toBe(0);
    expect(account?.apiHash).toBe("");
  });
});

// ─── POST /:id/run credential fallback ───────────────────────────────────────

describe("manual run credential fallback", () => {
  const run = () => routeHandler("post", "/:id/run");

  it("falls back to global defaults when the account has no credentials", async () => {
    await setDefaultCreds({ apiId: 999, apiHash: "global-hash" });
    const jobId = await insertCheckinJob(await insertAccount(null, null));

    const res = makeRes();
    await run()({ params: { id: String(jobId) }, body: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(runJob).toHaveBeenCalledTimes(1);
    const account = vi.mocked(runJob).mock.calls[0][1];
    expect(account?.apiId).toBe(999);
    expect(account?.apiHash).toBe("global-hash");
  });

  it("uses the account's own complete pair over the defaults", async () => {
    await setDefaultCreds({ apiId: 999, apiHash: "global-hash" });
    const jobId = await insertCheckinJob(await insertAccount(111, "own-hash"));

    const res = makeRes();
    await run()({ params: { id: String(jobId) }, body: {} }, res);

    const account = vi.mocked(runJob).mock.calls[0][1];
    expect(account?.apiId).toBe(111);
    expect(account?.apiHash).toBe("own-hash");
  });

  it("returns 400 when no credentials are available anywhere", async () => {
    const jobId = await insertCheckinJob(await insertAccount(null, null));

    const res = makeRes();
    await run()({ params: { id: String(jobId) }, body: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/No API credentials available/);
    expect(runJob).not.toHaveBeenCalled();
  });
});
