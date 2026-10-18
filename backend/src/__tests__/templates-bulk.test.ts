// Tests for the three bulk template endpoints:
//   PUT  /templates/:id/jobs/enabled      — enable / disable all linked jobs
//   GET  /templates/:id/available-accounts — accounts with no job for this template
//   POST /templates/:id/create-jobs        — bulk-create jobs from a template
//
// The old version of this file copied each endpoint's SQL into a helper and asserted on the
// copy, which could only ever prove the copy agreed with itself. These drive the real routes
// over HTTP, so a change in the endpoints is something the tests can actually notice.

import http from "http";
import express from "express";

vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import templatesRouter from "../routes/templates";
import { createAccount } from "../db/repos/accounts";
import { createTemplate, getTemplate } from "../db/repos/templates";
import { getJob } from "../db/repos/jobs";
import { insert, jobDoc, syncCounter, useTestDb } from "./helpers/db";
import type { JobDoc, JobTemplateDoc } from "../db/types";

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

let jobSeq = 0;

async function insertTemplate(
  fields: Partial<{
    jobType: string;
    botUsername: string;
    config: unknown;
  }> = {},
): Promise<JobTemplateDoc> {
  const id = await createTemplate({
    name: "Tpl",
    job_type: fields.jobType ?? "checkin",
    bot_username: fields.botUsername ?? "testbot",
    timezone: "Australia/Sydney",
    reply_timeout_ms: 40000,
    retry_max: 5,
    enabled: 1,
    config: fields.config != null ? JSON.stringify(fields.config) : null,
    start_command: "/start",
    checkin_button: "签到",
    run_every_days: 1,
  });
  return (await getTemplate(id))!;
}

async function insertAccount(
  fields: Partial<{ name: string; disabled: number }> = {},
): Promise<number> {
  return createAccount({
    name: fields.name ?? "Acct",
    phone_number: "+10000000000",
    disabled: fields.disabled ?? 0,
  });
}

async function insertJob(
  fields: Partial<{
    name: string;
    templateId: number | null;
    accountId: number | null;
    jobType: string;
    enabled: number;
    config: unknown;
    retired: string | null;
  }> = {},
): Promise<JobDoc> {
  const id = ++jobSeq;
  await insert("jobs", [
    jobDoc({
      _id: id,
      name: fields.name ?? "Job",
      template_id: fields.templateId ?? null,
      account_id: fields.accountId ?? null,
      job_type: fields.jobType ?? "checkin",
      enabled: fields.enabled ?? 1,
      config: fields.config != null ? JSON.stringify(fields.config) : null,
      retired: fields.retired ?? null,
    }),
  ]);
  await syncCounter("jobs", id);
  return (await getJob(id))!;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl: string;

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const setLinkedJobsEnabled = (templateId: number, enabled: boolean) =>
  request("PUT", `/templates/${templateId}/jobs/enabled`, { enabled });

const getAvailableAccounts = (templateId: number) =>
  request("GET", `/templates/${templateId}/available-accounts`);

async function createJobs(
  templateId: number,
  jobs: Array<{ accountId: number; name: string; config?: Record<string, unknown> }>,
  scheduleWindowStart: number,
  scheduleWindowEnd: number,
): Promise<{ status: number; ids: number[] }> {
  const res = await request("POST", `/templates/${templateId}/create-jobs`, {
    jobs,
    scheduleWindowStart,
    scheduleWindowEnd,
  });
  return { status: res.status, ids: res.body?.ids ?? [] };
}

useTestDb();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/templates", templatesRouter);
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
  jobSeq = 0;
});

// ---------------------------------------------------------------------------
// Enable / disable all linked jobs
// ---------------------------------------------------------------------------

describe("PUT /templates/:id/jobs/enabled", () => {
  it("disables all jobs linked to the template", async () => {
    const t = await insertTemplate();
    const j1 = await insertJob({ templateId: t._id, enabled: 1 });
    const j2 = await insertJob({ templateId: t._id, enabled: 1 });

    const res = await setLinkedJobsEnabled(t._id, false);

    expect(res.status).toBe(200);
    expect((await getJob(j1._id))!.enabled).toBe(0);
    expect((await getJob(j2._id))!.enabled).toBe(0);
  });

  it("enables all jobs linked to the template", async () => {
    const t = await insertTemplate();
    const j1 = await insertJob({ templateId: t._id, enabled: 0 });
    const j2 = await insertJob({ templateId: t._id, enabled: 0 });

    await setLinkedJobsEnabled(t._id, true);

    expect((await getJob(j1._id))!.enabled).toBe(1);
    expect((await getJob(j2._id))!.enabled).toBe(1);
  });

  it("does not affect jobs linked to a different template", async () => {
    const t1 = await insertTemplate();
    const t2 = await insertTemplate();
    const j1 = await insertJob({ templateId: t1._id, enabled: 1 });
    const j2 = await insertJob({ templateId: t2._id, enabled: 1 });

    await setLinkedJobsEnabled(t1._id, false);

    expect((await getJob(j1._id))!.enabled).toBe(0);
    expect((await getJob(j2._id))!.enabled).toBe(1);
  });

  it("does not affect unlinked jobs", async () => {
    const t = await insertTemplate();
    const linked = await insertJob({ templateId: t._id, enabled: 1 });
    const unlinked = await insertJob({ templateId: null, enabled: 1 });

    await setLinkedJobsEnabled(t._id, false);

    expect((await getJob(linked._id))!.enabled).toBe(0);
    expect((await getJob(unlinked._id))!.enabled).toBe(1);
  });

  it("is a no-op when the template has no linked jobs", async () => {
    const t = await insertTemplate();
    const res = await setLinkedJobsEnabled(t._id, false);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Available accounts (candidates for job creation)
// ---------------------------------------------------------------------------

describe("GET /templates/:id/available-accounts", () => {
  it("returns all enabled accounts when no jobs exist for the template", async () => {
    const t = await insertTemplate();
    const a1 = await insertAccount({ name: "Alice" });
    const a2 = await insertAccount({ name: "Bob" });

    const { body } = await getAvailableAccounts(t._id);

    expect(body.map((r: any) => r.id)).toEqual(
      expect.arrayContaining([a1, a2]),
    );
  });

  it("excludes accounts that already have a job for this template", async () => {
    const t = await insertTemplate();
    const a1 = await insertAccount({ name: "Alice" });
    const a2 = await insertAccount({ name: "Bob" });
    await insertJob({ templateId: t._id, accountId: a1 });

    const { body } = await getAvailableAccounts(t._id);

    const ids = body.map((r: any) => r.id);
    expect(ids).not.toContain(a1);
    expect(ids).toContain(a2);
  });

  it("does not exclude an account whose only job for this template is retired", async () => {
    const t = await insertTemplate();
    const a1 = await insertAccount({ name: "Alice" });
    const a2 = await insertAccount({ name: "Bob" });
    await insertJob({ templateId: t._id, accountId: a1, retired: "account deleted" });
    await insertJob({ templateId: t._id, accountId: a2 });

    const { body } = await getAvailableAccounts(t._id);

    const ids = body.map((r: any) => r.id);
    expect(ids).toContain(a1);
    expect(ids).not.toContain(a2);
  });

  it("still excludes an account with both a retired and an active job for this template", async () => {
    const t = await insertTemplate();
    const a = await insertAccount({ name: "Alice" });
    await insertJob({ templateId: t._id, accountId: a, retired: "account deleted" });
    await insertJob({ templateId: t._id, accountId: a });

    const { body } = await getAvailableAccounts(t._id);

    expect(body.map((r: any) => r.id)).not.toContain(a);
  });

  it("does not exclude an account linked to a different template", async () => {
    const t1 = await insertTemplate();
    const t2 = await insertTemplate();
    const a = await insertAccount({ name: "Carol" });
    // Account is linked to t1, not t2
    await insertJob({ templateId: t1._id, accountId: a });

    const { body } = await getAvailableAccounts(t2._id);

    expect(body.map((r: any) => r.id)).toContain(a);
  });

  it("excludes disabled accounts", async () => {
    const t = await insertTemplate();
    const active = await insertAccount({ name: "Active", disabled: 0 });
    const disabled = await insertAccount({ name: "Disabled", disabled: 1 });

    const { body } = await getAvailableAccounts(t._id);

    const ids = body.map((r: any) => r.id);
    expect(ids).toContain(active);
    expect(ids).not.toContain(disabled);
  });

  it("returns accounts ordered alphabetically by name", async () => {
    const t = await insertTemplate();
    await insertAccount({ name: "Zara" });
    await insertAccount({ name: "Alice" });
    await insertAccount({ name: "Mike" });

    const { body } = await getAvailableAccounts(t._id);

    const names = body.map((r: any) => r.name);
    expect(names).toEqual(
      [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
    );
  });

  it("returns empty list when all accounts already have a job for this template", async () => {
    const t = await insertTemplate();
    const a = await insertAccount();
    await insertJob({ templateId: t._id, accountId: a });

    const { body } = await getAvailableAccounts(t._id);

    expect(body).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bulk create jobs from template
// ---------------------------------------------------------------------------

describe("POST /templates/:id/create-jobs", () => {
  it("creates the requested number of jobs", async () => {
    const t = await insertTemplate();
    const a1 = await insertAccount({ name: "A1" });
    const a2 = await insertAccount({ name: "A2" });

    const { status, ids } = await createJobs(
      t._id,
      [
        { accountId: a1, name: "Job A1" },
        { accountId: a2, name: "Job A2" },
      ],
      1400,
      1600,
    );

    expect(status).toBe(201);
    expect(ids).toHaveLength(2);
  });

  it("links created jobs to the template", async () => {
    const t = await insertTemplate();
    const a = await insertAccount();

    const { ids } = await createJobs(t._id, [{ accountId: a, name: "Linked Job" }], 1400, 1600);

    expect((await getJob(ids[0]))!.template_id).toBe(t._id);
  });

  it("copies template fields onto each created job", async () => {
    const t = await insertTemplate({ jobType: "checkin", botUsername: "mybot" });
    const a = await insertAccount();

    const { ids } = await createJobs(t._id, [{ accountId: a, name: "Test" }], 1000, 1200);
    const job = (await getJob(ids[0]))!;

    expect(job.job_type).toBe("checkin");
    expect(job.bot_username).toBe("mybot");
    expect(job.schedule_window_start).toBe(1000);
    expect(job.schedule_window_end).toBe(1200);
    expect(job.account_id).toBe(a);
    expect(job.name).toBe("Test");
    expect(job.enabled).toBe(1);
  });

  it("merges embywatch credentials into template config", async () => {
    const t = await insertTemplate({
      jobType: "embywatch",
      config: { playDuration: 300, markWatched: true },
    });
    const a = await insertAccount();

    const { ids } = await createJobs(
      t._id,
      [{ accountId: a, name: "Watch Job", config: { username: "alice", password: "secret" } }],
      1400,
      1600,
    );

    const merged = JSON.parse((await getJob(ids[0]))!.config!);
    expect(merged.playDuration).toBe(300);
    expect(merged.markWatched).toBe(true);
    expect(merged.username).toBe("alice");
    expect(merged.password).toBe("secret");
  });

  it("job-level credentials override duplicate keys in template config", async () => {
    // Templates should not store credentials, but job config wins on conflict
    const t = await insertTemplate({
      jobType: "embywatch",
      config: { username: "template-user", playDuration: 300 },
    });
    const a = await insertAccount();

    const { ids } = await createJobs(
      t._id,
      [{ accountId: a, name: "Override Test", config: { username: "real-user", password: "pw" } }],
      1400,
      1600,
    );

    const merged = JSON.parse((await getJob(ids[0]))!.config!);
    expect(merged.username).toBe("real-user");
    expect(merged.playDuration).toBe(300);
  });

  it("does not merge config for non-embywatch jobs", async () => {
    const t = await insertTemplate({ jobType: "checkin", config: null });
    const a = await insertAccount();

    // Passing a config for a checkin job should be ignored (no merge for checkin)
    const { ids } = await createJobs(
      t._id,
      [{ accountId: a, name: "Checkin", config: { someField: "value" } }],
      1400,
      1600,
    );

    expect((await getJob(ids[0]))!.config).toBeNull();
  });

  it("creates multiple jobs with individual account IDs", async () => {
    const t = await insertTemplate();
    const a1 = await insertAccount({ name: "A1" });
    const a2 = await insertAccount({ name: "A2" });
    const a3 = await insertAccount({ name: "A3" });

    const { ids } = await createJobs(
      t._id,
      [
        { accountId: a1, name: "J1" },
        { accountId: a2, name: "J2" },
        { accountId: a3, name: "J3" },
      ],
      800,
      1000,
    );

    const accountIds = [];
    for (const id of ids) accountIds.push((await getJob(id))!.account_id);
    expect(accountIds).toEqual([a1, a2, a3]);
  });

  it("404s for a template that does not exist", async () => {
    const { status } = await createJobs(4242, [{ accountId: 1, name: "Orphan" }], 800, 1000);
    expect(status).toBe(404);
  });

  it("400s when the jobs array is empty", async () => {
    const t = await insertTemplate();
    const { status } = await createJobs(t._id, [], 800, 1000);
    expect(status).toBe(400);
  });
});
