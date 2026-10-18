// Templates: the repository's own behaviour, the cascade that unlinks jobs when a template
// goes away, the sync that pushes a template's fields onto its jobs, and the merge the runner
// does at execution time.
//
// The old version of this file re-implemented the route's SQL as a second copy and asserted on
// that. It now drives the real thing: the repository for storage, `syncLinkedJobs` for the
// sync (exported for exactly this reason), and a real PUT for the config lock, which is the
// only way a test can notice the route changing its mind.

import http from "http";
import express from "express";

vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));
vi.mock("../jobs/embywatch", () => ({ runEmbywatch: vi.fn() }));
vi.mock("../jobs/checkin", () => ({
  runCheckin: vi.fn(),
  CheckinError: class extends Error {
    log: unknown;
    constructor(msg: string, log: unknown) { super(msg); this.log = log; }
  },
}));
vi.mock("../jobs/custom", () => ({
  runCustom: vi.fn(),
  CustomJobError: class extends Error {
    log: unknown;
    constructor(msg: string, log: unknown) { super(msg); this.log = log; }
  },
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { runJob, type JobDetailLog } from "../jobs/runner";
import { runEmbywatch } from "../jobs/embywatch";
import { syncLinkedJobs } from "../routes/templates";
import jobsRouter from "../routes/jobs";
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  updateTemplate,
} from "../db/repos/templates";
import { getJob } from "../db/repos/jobs";
import { insert, jobDoc, syncCounter, useTestDb } from "./helpers/db";
import type { JobDoc, JobTemplateDoc } from "../db/types";
import type { Job } from "../types";

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function insertTemplate(
  fields: Partial<{
    name: string;
    jobType: string;
    botUsername: string;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    config: unknown;
    startCommand: string;
    checkinButton: string;
    runEveryDays: number;
  }> = {},
): Promise<JobTemplateDoc> {
  const id = await createTemplate({
    name: fields.name ?? "Test Template",
    job_type: fields.jobType ?? "checkin",
    bot_username: fields.botUsername ?? "testbot",
    timezone: fields.timezone ?? "Australia/Sydney",
    reply_timeout_ms: fields.replyTimeoutMs ?? 40000,
    retry_max: fields.retryMax ?? 5,
    enabled: 1,
    config: fields.config != null ? JSON.stringify(fields.config) : null,
    start_command: fields.startCommand ?? "/start",
    checkin_button: fields.checkinButton ?? "签到",
    run_every_days: fields.runEveryDays ?? 1,
  });
  return (await getTemplate(id))!;
}

let jobSeq = 0;

async function insertJob(
  fields: Partial<{
    name: string;
    jobType: string;
    botUsername: string;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    config: unknown;
    startCommand: string;
    checkinButton: string;
    templateId: number | null;
    accountId: number | null;
    runEveryDays: number;
  }> = {},
): Promise<JobDoc> {
  const id = ++jobSeq;
  const doc = jobDoc({
    _id: id,
    name: fields.name ?? "Test Job",
    job_type: fields.jobType ?? "checkin",
    bot_username: fields.botUsername ?? "testbot",
    timezone: fields.timezone ?? "Australia/Sydney",
    reply_timeout_ms: fields.replyTimeoutMs ?? 40000,
    retry_max: fields.retryMax ?? 5,
    config: fields.config != null ? JSON.stringify(fields.config) : (fields.config as null),
    start_command: fields.startCommand ?? "/start",
    checkin_button: fields.checkinButton ?? "签到",
    template_id: fields.templateId ?? null,
    account_id: fields.accountId ?? null,
    run_every_days: fields.runEveryDays ?? 1,
  });
  await insert("jobs", [doc]);
  await syncCounter("jobs", id);
  return (await getJob(id))!;
}

// ---------------------------------------------------------------------------
// Real PUT /jobs/:id -- the config lock lives in the route, so the route is
// the only thing that can be asked about it.
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl: string;

async function putJob(jobId: number, body: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${baseUrl}/jobs/${jobId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status;
}

function makeJobObj(row: JobDoc, overrides: Partial<Job> = {}): Job {
  return {
    id: row._id,
    name: row.name,
    accountId: row.account_id,
    jobType: row.job_type as Job["jobType"],
    botUsername: row.bot_username,
    scheduleWindowStart: 1000,
    scheduleWindowEnd: 1200,
    timezone: row.timezone,
    replyTimeoutMs: row.reply_timeout_ms,
    retryMax: 1,
    enabled: true,
    createdAt: "2024-01-01T00:00:00Z",
    config: row.config ?? null,
    startCommand: row.start_command ?? "/start",
    checkinButton: row.checkin_button ?? "签到",
    templateId: row.template_id,
    runEveryDays: 1,
    ...overrides,
  };
}

useTestDb();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/jobs", jobsRouter);
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
// Template CRUD
// ---------------------------------------------------------------------------

describe("Template CRUD", () => {
  it("creates and retrieves a template", async () => {
    const t = await insertTemplate({ name: "Daily Checkin", jobType: "checkin", botUsername: "bot1" });
    expect(t._id).toBeGreaterThan(0);
    expect(t.name).toBe("Daily Checkin");
    expect(t.job_type).toBe("checkin");
    expect(t.bot_username).toBe("bot1");
  });

  it("stores serialised config", async () => {
    const cfg = { playDuration: 300, markWatched: true };
    const t = await insertTemplate({ config: cfg });
    expect(JSON.parse(t.config!)).toEqual(cfg);
  });

  it("updates a template name and retry count", async () => {
    const t = await insertTemplate({ name: "Original", retryMax: 3 });
    await updateTemplate(t._id, { name: "Updated", retry_max: 7 });
    const updated = (await getTemplate(t._id))!;
    expect(updated.name).toBe("Updated");
    expect(updated.retry_max).toBe(7);
  });

  it("deletes a template", async () => {
    const t = await insertTemplate();
    await deleteTemplate(t._id);
    expect(await getTemplate(t._id)).toBeNull();
  });

  it("stores null config when none is provided", async () => {
    const t = await insertTemplate();
    expect(t.config).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Template update syncs linked jobs
// ---------------------------------------------------------------------------

describe("Template update -- syncLinkedJobs", () => {
  it("propagates field changes to all linked jobs", async () => {
    const t = await insertTemplate({ botUsername: "old-bot", timezone: "UTC", retryMax: 3 });
    const job1 = await insertJob({ templateId: t._id });
    const job2 = await insertJob({ templateId: t._id });
    const unlinked = await insertJob();

    const updated: JobTemplateDoc = {
      ...t,
      bot_username: "new-bot",
      timezone: "America/New_York",
      retry_max: 9,
    };
    await updateTemplate(t._id, {
      bot_username: "new-bot",
      timezone: "America/New_York",
      retry_max: 9,
    });
    await syncLinkedJobs(t._id, updated);

    expect((await getJob(job1._id))!.bot_username).toBe("new-bot");
    expect((await getJob(job1._id))!.timezone).toBe("America/New_York");
    expect((await getJob(job1._id))!.retry_max).toBe(9);
    expect((await getJob(job2._id))!.bot_username).toBe("new-bot");
    // Unlinked job is untouched
    expect((await getJob(unlinked._id))!.bot_username).toBe(unlinked.bot_username);
  });

  it("syncs config when template config changes", async () => {
    const t = await insertTemplate({ config: { playDuration: 300 } });
    const job = await insertJob({ templateId: t._id });

    const newConfig = JSON.stringify({ playDuration: 600, markWatched: true });
    await updateTemplate(t._id, { config: newConfig });
    await syncLinkedJobs(t._id, { ...t, config: newConfig });

    expect((await getJob(job._id))!.config).toBe(newConfig);
  });

  it("does not modify jobs linked to a different template", async () => {
    const t1 = await insertTemplate({ botUsername: "bot-a" });
    const t2 = await insertTemplate({ botUsername: "bot-b" });
    const jobT1 = await insertJob({ templateId: t1._id, botUsername: "bot-a" });
    const jobT2 = await insertJob({ templateId: t2._id, botUsername: "bot-b" });

    await syncLinkedJobs(t1._id, { ...t1, bot_username: "bot-updated" });

    expect((await getJob(jobT1._id))!.bot_username).toBe("bot-updated");
    expect((await getJob(jobT2._id))!.bot_username).toBe("bot-b");
  });

  it("preserves per-job credentials when an embywatch template config is updated", async () => {
    const t = await insertTemplate({
      jobType: "embywatch",
      config: { playDuration: 300, markWatched: true },
    });
    const job1 = await insertJob({
      jobType: "embywatch",
      templateId: t._id,
      config: { playDuration: 300, markWatched: true, username: "alice", password: "secret1" },
    });
    const job2 = await insertJob({
      jobType: "embywatch",
      templateId: t._id,
      config: { playDuration: 300, markWatched: true, username: "bob", password: "secret2" },
    });

    const newConfig = JSON.stringify({ playDuration: 600, markWatched: false });
    await updateTemplate(t._id, { config: newConfig });
    await syncLinkedJobs(t._id, { ...t, config: newConfig });

    const cfg1 = JSON.parse((await getJob(job1._id))!.config!);
    const cfg2 = JSON.parse((await getJob(job2._id))!.config!);

    // Template settings updated
    expect(cfg1.playDuration).toBe(600);
    expect(cfg1.markWatched).toBe(false);
    expect(cfg2.playDuration).toBe(600);
    expect(cfg2.markWatched).toBe(false);

    // Per-job credentials preserved
    expect(cfg1.username).toBe("alice");
    expect(cfg1.password).toBe("secret1");
    expect(cfg2.username).toBe("bob");
    expect(cfg2.password).toBe("secret2");
  });
});

// ---------------------------------------------------------------------------
// Template deletion cascade
// ---------------------------------------------------------------------------

describe("Template deletion -- unlinks jobs", () => {
  it("sets template_id to null on a linked job when the template is deleted", async () => {
    const t = await insertTemplate();
    const job = await insertJob({ templateId: t._id });
    expect((await getJob(job._id))!.template_id).toBe(t._id);

    await deleteTemplate(t._id);

    expect((await getJob(job._id))!.template_id).toBeNull();
    expect(await getTemplate(t._id)).toBeNull();
  });

  it("unlinks all jobs when template is deleted", async () => {
    const t = await insertTemplate();
    const jobs = [
      await insertJob({ templateId: t._id }),
      await insertJob({ templateId: t._id }),
      await insertJob({ templateId: t._id }),
    ];

    await deleteTemplate(t._id);

    for (const j of jobs) {
      expect((await getJob(j._id))!.template_id).toBeNull();
    }
  });

  it("does not affect jobs linked to a different template", async () => {
    const t1 = await insertTemplate();
    const t2 = await insertTemplate();
    const jobT1 = await insertJob({ templateId: t1._id });
    const jobT2 = await insertJob({ templateId: t2._id });

    await deleteTemplate(t1._id);

    expect((await getJob(jobT1._id))!.template_id).toBeNull();
    expect((await getJob(jobT2._id))!.template_id).toBe(t2._id);
  });
});

// ---------------------------------------------------------------------------
// Applying a template to a job (linking)
// ---------------------------------------------------------------------------

describe("Applying a template", () => {
  it("sets template_id on the job", async () => {
    const t = await insertTemplate();
    const job = await insertJob();
    await putJob(job._id, { templateId: t._id });
    expect((await getJob(job._id))!.template_id).toBe(t._id);
  });

  it("locks template-controlled fields once a job is linked", async () => {
    const t = await insertTemplate({ botUsername: "template-bot", timezone: "UTC", retryMax: 3 });
    const job = await insertJob({
      templateId: t._id,
      botUsername: "job-bot",
      timezone: "Australia/Sydney",
      retryMax: 5,
    });

    // Attempt to override locked fields (no templateId in body => isLinked = true)
    await putJob(job._id, { botUsername: "override-bot", timezone: "Asia/Tokyo", retryMax: 99 });

    const updated = (await getJob(job._id))!;
    expect(updated.bot_username).toBe("job-bot");
    expect(updated.timezone).toBe("Australia/Sydney");
    expect(updated.retry_max).toBe(5);
  });

  it("still allows updating job name and accountId while linked", async () => {
    const t = await insertTemplate();
    const job = await insertJob({ templateId: t._id, name: "Original Name" });

    await putJob(job._id, { name: "Renamed Job" });

    expect((await getJob(job._id))!.name).toBe("Renamed Job");
    expect((await getJob(job._id))!.template_id).toBe(t._id);
  });

  it("does not change accountId when a template is applied", async () => {
    const t = await insertTemplate();
    // Embywatch-style job with no account
    const job = await insertJob({ accountId: null });

    await putJob(job._id, { templateId: t._id });

    expect((await getJob(job._id))!.account_id).toBeNull();
    expect((await getJob(job._id))!.template_id).toBe(t._id);
  });

  it("locks config for non-embywatch template-linked jobs", async () => {
    const t = await insertTemplate({ jobType: "checkin" });
    const job = await insertJob({ jobType: "checkin", templateId: t._id, config: null });

    await putJob(job._id, { config: { someField: "value" } });

    expect((await getJob(job._id))!.config).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Removing a template from a job (unlinking)
// ---------------------------------------------------------------------------

describe("Removing a template", () => {
  it("clears template_id when explicitly unlinked", async () => {
    const t = await insertTemplate();
    const job = await insertJob({ templateId: t._id });

    await putJob(job._id, { templateId: null });

    expect((await getJob(job._id))!.template_id).toBeNull();
  });

  it("allows updating previously locked fields after unlinking", async () => {
    const t = await insertTemplate({ botUsername: "template-bot", timezone: "UTC" });
    const job = await insertJob({
      templateId: t._id,
      botUsername: "template-bot",
      timezone: "UTC",
    });

    // Unlink and update in the same PUT
    await putJob(job._id, {
      templateId: null,
      botUsername: "my-bot",
      timezone: "Australia/Sydney",
    });

    const updated = (await getJob(job._id))!;
    expect(updated.template_id).toBeNull();
    expect(updated.bot_username).toBe("my-bot");
    expect(updated.timezone).toBe("Australia/Sydney");
  });

  it("leaves the template unchanged when a job is unlinked", async () => {
    const t = await insertTemplate({ name: "Shared Template" });
    const job = await insertJob({ templateId: t._id });

    await putJob(job._id, { templateId: null });

    expect((await getTemplate(t._id))!.name).toBe("Shared Template");
  });

  it("a second unlink on an already unlinked job is a no-op", async () => {
    const job = await insertJob({ templateId: null });

    await putJob(job._id, { templateId: null });

    expect((await getJob(job._id))!.template_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// embywatch -- config writable even when linked
// ---------------------------------------------------------------------------

describe("embywatch -- config writable when template-linked", () => {
  it("allows saving credentials to a template-linked embywatch job", async () => {
    const t = await insertTemplate({ jobType: "embywatch", config: { playDuration: 300 } });
    const job = await insertJob({ jobType: "embywatch", templateId: t._id, config: null });

    await putJob(job._id, { config: { username: "alice", password: "secret" } });

    expect(JSON.parse((await getJob(job._id))!.config!)).toEqual({
      username: "alice",
      password: "secret",
    });
  });

  it("does not overwrite credentials when only the job name is updated", async () => {
    const t = await insertTemplate({ jobType: "embywatch" });
    const job = await insertJob({
      jobType: "embywatch",
      templateId: t._id,
      config: { username: "bob", password: "pw" },
    });

    await putJob(job._id, { name: "Renamed" });

    expect((await getJob(job._id))!.name).toBe("Renamed");
    expect(JSON.parse((await getJob(job._id))!.config!)).toEqual({
      username: "bob",
      password: "pw",
    });
  });
});

// ---------------------------------------------------------------------------
// Runner -- embywatch template config merge at runtime
// ---------------------------------------------------------------------------

describe("Runner -- embywatch template config merge", () => {
  it("merges template playback config with job credentials", async () => {
    const template = await insertTemplate({
      jobType: "embywatch",
      config: { playDuration: 600, markWatched: true, userAgent: "TestAgent/1.0" },
    });
    const jobRow = await insertJob({
      jobType: "embywatch",
      templateId: template._id,
      config: { username: "user1", password: "pass1" },
    });

    vi.mocked(runEmbywatch).mockResolvedValue({ played: 1, total: 1 } as any);

    const logs: JobDetailLog[] = [];
    await runJob(makeJobObj(jobRow), null, logs);

    expect(vi.mocked(runEmbywatch)).toHaveBeenCalledOnce();
    const merged = vi.mocked(runEmbywatch).mock.calls[0][1];
    expect(merged.playDuration).toBe(600);
    expect(merged.markWatched).toBe(true);
    expect(merged.userAgent).toBe("TestAgent/1.0");
    expect(merged.username).toBe("user1");
    expect(merged.password).toBe("pass1");
    expect(logs).toHaveLength(1);
  });

  it("job credentials override any credential fields in template config", async () => {
    // Templates should not store credentials, but job config always wins on merge
    const template = await insertTemplate({
      jobType: "embywatch",
      config: { username: "template-user", password: "template-pass", playDuration: 300 },
    });
    const jobRow = await insertJob({
      jobType: "embywatch",
      templateId: template._id,
      config: { username: "job-user", password: "job-pass" },
    });

    vi.mocked(runEmbywatch).mockResolvedValue({ played: 0, total: 0 } as any);

    await runJob(makeJobObj(jobRow), null, []);

    const merged = vi.mocked(runEmbywatch).mock.calls[0][1];
    expect(merged.username).toBe("job-user");
    expect(merged.password).toBe("job-pass");
    expect(merged.playDuration).toBe(300);
  });

  it("throws when credentials are absent even with a template linked", async () => {
    const template = await insertTemplate({ jobType: "embywatch", config: { playDuration: 300 } });
    const jobRow = await insertJob({
      jobType: "embywatch",
      templateId: template._id,
      config: null,
    });

    await expect(runJob(makeJobObj(jobRow), null, [])).rejects.toThrow(
      "Emby username and password are required",
    );
    expect(vi.mocked(runEmbywatch)).not.toHaveBeenCalled();
  });

  it("uses job config directly when no template is linked", async () => {
    const jobRow = await insertJob({
      jobType: "embywatch",
      templateId: null,
      config: { username: "solo", password: "solo-pass", playDuration: 120 },
    });

    vi.mocked(runEmbywatch).mockResolvedValue({ played: 1, total: 1 } as any);

    await runJob(makeJobObj(jobRow), null, []);

    const calledWith = vi.mocked(runEmbywatch).mock.calls[0][1];
    expect(calledWith.username).toBe("solo");
    expect(calledWith.password).toBe("solo-pass");
    expect(calledWith.playDuration).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Template update syncs run_every_days to linked jobs
// ---------------------------------------------------------------------------

describe("Template update -- run_every_days sync", () => {
  it("propagates run_every_days to all linked jobs", async () => {
    const t = await insertTemplate({ runEveryDays: 1 });
    const job1 = await insertJob({ templateId: t._id });
    const job2 = await insertJob({ templateId: t._id });
    const unlinked = await insertJob();

    const updated: JobTemplateDoc = { ...t, run_every_days: 10 };
    await updateTemplate(t._id, { run_every_days: 10 });
    await syncLinkedJobs(t._id, updated);

    expect((await getJob(job1._id))!.run_every_days).toBe(10);
    expect((await getJob(job2._id))!.run_every_days).toBe(10);
    // Unlinked job is untouched
    expect((await getJob(unlinked._id))!.run_every_days).toBe(1);
  });

  it("does not change run_every_days on jobs linked to a different template", async () => {
    const t1 = await insertTemplate({ runEveryDays: 1 });
    const t2 = await insertTemplate({ runEveryDays: 1 });
    const jobT1 = await insertJob({ templateId: t1._id });
    const jobT2 = await insertJob({ templateId: t2._id });

    await syncLinkedJobs(t1._id, { ...t1, run_every_days: 7 });

    expect((await getJob(jobT1._id))!.run_every_days).toBe(7);
    expect((await getJob(jobT2._id))!.run_every_days).toBe(1);
  });

  it("stores the updated run_every_days on the template itself", async () => {
    const t = await insertTemplate({ runEveryDays: 1 });
    await updateTemplate(t._id, { run_every_days: 14 });
    expect((await getTemplate(t._id))!.run_every_days).toBe(14);
  });
});
