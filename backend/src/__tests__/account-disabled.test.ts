// Tests for the account-disable feature:
//   1. The `disabled` field — 0 for a new account, and toggleable afterwards
//   2. Scheduler filter — loadEligibleJobs excludes jobs whose account is disabled,
//      keeps jobs with enabled accounts, and keeps no-account (embywatch) jobs.
//
// Where the old suite wrote rows straight into SQLite and read back a column, these go
// through the repositories: with no `DEFAULT 0` in a schema to lean on, the default and the
// cascade that keeps an orphaned job alive both live in that code now.

vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildFailureMessage: vi.fn(),
  buildSuccessMessage: vi.fn(),
  getNotifyConfig: vi.fn().mockReturnValue({ events: [], username: null }),
}));
vi.mock("../jobs/cancellation", () => ({
  registerJob: vi.fn().mockReturnValue(new AbortController().signal),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));

import { describe, it, expect, vi } from "vitest";
import { loadEligibleJobs } from "../scheduler";
import { createAccount, deleteAccount, getAccount, updateAccount } from "../db/repos/accounts";
import { getJob } from "../db/repos/jobs";
import { insert, jobDoc, useTestDb } from "./helpers/db";
import type { AccountDoc, JobDoc } from "../db/types";

let nextJobId = 0;

async function insertAccount(
  fields: Partial<{
    name: string;
    authStatus: string;
    sessionString: string | null;
    disabled: number;
    appClientId: string | null;
  }> = {},
): Promise<AccountDoc> {
  const id = await createAccount({
    name: fields.name ?? "Acct",
    phone_number: "+10000000000",
    auth_status: fields.authStatus ?? "authenticated",
    session_string: fields.sessionString !== undefined ? fields.sessionString : "sess",
    disabled: fields.disabled ?? 0,
    app_client_id: fields.appClientId ?? null,
  });
  return (await getAccount(id))!;
}

async function insertJob(
  fields: Partial<{
    name: string;
    accountId: number | null;
    jobType: string;
    enabled: number;
  }> = {},
): Promise<JobDoc> {
  const id = ++nextJobId;
  await insert("jobs", [
    jobDoc({
      _id: id,
      name: fields.name ?? "Job",
      account_id: fields.accountId ?? null,
      job_type: fields.jobType ?? "checkin",
      enabled: fields.enabled ?? 1,
    }),
  ]);
  return (await getJob(id))!;
}

const eligibleIds = async () => (await loadEligibleJobs()).map((e) => e.job.id);

useTestDb();

// ---------------------------------------------------------------------------
// The disabled field
// ---------------------------------------------------------------------------

describe("tg_accounts.disabled", () => {
  it("defaults to 0 for a newly inserted account", async () => {
    const a = await insertAccount();
    expect(a.disabled).toBe(0);
  });

  it("persists disabled = 1 after an update", async () => {
    const a = await insertAccount({ disabled: 0 });
    await updateAccount(a._id, { disabled: 1 });
    expect((await getAccount(a._id))!.disabled).toBe(1);
  });

  it("can be toggled back to 0", async () => {
    const a = await insertAccount({ disabled: 1 });
    await updateAccount(a._id, { disabled: 0 });
    expect((await getAccount(a._id))!.disabled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scheduler filter — loadEligibleJobs
// ---------------------------------------------------------------------------

describe("loadEligibleJobs — disabled account filter", () => {
  it("excludes a checkin job whose account is disabled", async () => {
    const disabledAcct = await insertAccount({ disabled: 1 });
    const job = await insertJob({ accountId: disabledAcct._id, jobType: "checkin" });

    expect(await eligibleIds()).not.toContain(job._id);
  });

  it("includes a checkin job whose account is enabled", async () => {
    const enabledAcct = await insertAccount({ disabled: 0 });
    const job = await insertJob({ accountId: enabledAcct._id, jobType: "checkin" });

    expect(await eligibleIds()).toContain(job._id);
  });

  it("includes an embywatch job with no account regardless of other disabled accounts", async () => {
    // Insert an unrelated disabled account to make sure the filter is precise
    await insertAccount({ disabled: 1 });
    const job = await insertJob({ accountId: null, jobType: "embywatch" });

    expect(await eligibleIds()).toContain(job._id);
  });

  it("excludes a custom job whose account is disabled", async () => {
    const disabledAcct = await insertAccount({ disabled: 1 });
    const job = await insertJob({ accountId: disabledAcct._id, jobType: "custom" });

    expect(await eligibleIds()).not.toContain(job._id);
  });

  it("keeps enabled-account jobs while filtering disabled-account jobs in the same query", async () => {
    const enabled = await insertAccount({ name: "Enabled", disabled: 0 });
    const disabled = await insertAccount({ name: "Disabled", disabled: 1 });
    const goodJob = await insertJob({ accountId: enabled._id, jobType: "checkin" });
    const badJob = await insertJob({ accountId: disabled._id, jobType: "checkin" });

    const ids = await eligibleIds();

    expect(ids).toContain(goodJob._id);
    expect(ids).not.toContain(badJob._id);
  });

  it("excludes a job that is explicitly disabled (enabled = 0)", async () => {
    const acct = await insertAccount({ disabled: 0 });
    const job = await insertJob({
      accountId: acct._id,
      jobType: "checkin",
      enabled: 0,
    });

    expect(await eligibleIds()).not.toContain(job._id);
  });

  it("excludes a checkin job whose account has no session string", async () => {
    const unauthAcct = await insertAccount({
      authStatus: "unauthenticated",
      sessionString: null,
      disabled: 0,
    });
    const job = await insertJob({ accountId: unauthAcct._id, jobType: "checkin" });

    expect(await eligibleIds()).not.toContain(job._id);
  });

  it("returns account with disabled=false on the account object for eligible jobs", async () => {
    const acct = await insertAccount({ disabled: 0 });
    await insertJob({ accountId: acct._id, jobType: "checkin" });

    const entry = (await loadEligibleJobs()).find((e) => e.account?.id === acct._id);

    expect(entry).toBeDefined();
    expect(entry!.account!.disabled).toBe(false);
  });

  it("returns account with the correct appClientId when one is set", async () => {
    const acct = await insertAccount({ disabled: 0, appClientId: "preset-ios" });
    await insertJob({ accountId: acct._id, jobType: "checkin" });

    const entry = (await loadEligibleJobs()).find((e) => e.account?.id === acct._id);

    expect(entry).toBeDefined();
    expect(entry!.account!.appClientId).toBe("preset-ios");
  });

  it("returns account with appClientId null when no client is assigned", async () => {
    const acct = await insertAccount({ disabled: 0 }); // no app_client_id set
    await insertJob({ accountId: acct._id, jobType: "checkin" });

    const entry = (await loadEligibleJobs()).find((e) => e.account?.id === acct._id);

    expect(entry!.account!.appClientId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scheduler filter — orphaned account_id (account row deleted / never existed)
//
// Regression test: deleting a tg_accounts row that still had jobs pointing at
// it used to leave the job silently unschedulable forever, because the query
// could not tell "no joined account row" from "job legitimately has no
// account" (embywatch). Only embywatch jobs kept appearing as a result.
// ---------------------------------------------------------------------------

describe("loadEligibleJobs — orphaned account (account_id set but row missing)", () => {
  it("excludes a checkin job after its linked account is deleted", async () => {
    const acct = await insertAccount({ disabled: 0 });
    const job = await insertJob({ accountId: acct._id, jobType: "checkin" });

    await deleteAccount(acct._id);
    // deleteAccount detaches the job, as the old ON DELETE SET NULL did
    expect((await getJob(job._id))!.account_id).toBeNull();

    expect(await eligibleIds()).not.toContain(job._id);
  });

  it("excludes a custom job whose account_id points at a nonexistent account", async () => {
    // Nothing enforces the reference any more, so a dangling id is simply a job whose
    // account cannot be loaded -- which is exactly what must not be scheduled.
    const job = await insertJob({ accountId: 999999, jobType: "custom" });

    expect(await eligibleIds()).not.toContain(job._id);
  });

  it("keeps an embywatch job schedulable once cascade nulls its optional account link", async () => {
    // account_id is optional for embywatch -- once the delete detaches it, the job
    // correctly falls back to running without a linked account.
    const acct = await insertAccount({ disabled: 0 });
    const job = await insertJob({ accountId: acct._id, jobType: "embywatch" });

    await deleteAccount(acct._id);

    expect(await eligibleIds()).toContain(job._id);
  });

  it("still includes healthy checkin/custom/embywatch jobs alongside an orphaned one", async () => {
    const acct = await insertAccount({ disabled: 0 });
    const healthyCheckin = await insertJob({ accountId: acct._id, jobType: "checkin" });
    const healthyWatch = await insertJob({ accountId: null, jobType: "embywatch" });

    const orphaned = await insertJob({ accountId: 424242, jobType: "checkin" });

    const ids = await eligibleIds();

    expect(ids).toContain(healthyCheckin._id);
    expect(ids).toContain(healthyWatch._id);
    expect(ids).not.toContain(orphaned._id);
  });
});
