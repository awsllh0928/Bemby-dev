// Contract tests for opt-in server-side pagination, filtering, and fuzzy search on the
// list endpoints (templates, jobs, accounts, logs). Without a `page`/`pageSize` param the
// legacy full-array response must be preserved for dropdown consumers.

import http from "http";
import express from "express";
import { fuzzyScore } from "../db/fuzzy";

const refreshScheduler = vi.fn();

vi.mock("../scheduler", () => ({ refreshScheduler }));
vi.mock("../auth/tgAuth", () => ({
  requestCode: vi.fn(),
  submitCode: vi.fn(),
  submitPassword: vi.fn(),
  checkAccountStatus: vi.fn(),
  resendCodeAsSms: vi.fn(),
  updateTwoFa: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  getSessions: vi.fn(),
  terminateSession: vi.fn(),
  terminateOtherSessions: vi.fn(),
  getPasswordInfo: vi.fn(),
  sendLoginEmailCode: vi.fn(),
  verifyLoginEmail: vi.fn(),
  getPasskeys: vi.fn(),
  deletePasskey: vi.fn(),
}));
vi.mock("../jobs/checkin", () => ({ checkSpamStatus: vi.fn(), runCheckin: vi.fn(), CheckinError: class extends Error {} }));
vi.mock("../jobs/custom", () => ({ runCustom: vi.fn(), CustomJobError: class extends Error {} }));
vi.mock("../jobs/embywatch", () => ({ runEmbywatch: vi.fn(), testEmbyConnection: vi.fn() }));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn(), parseTgProxy: vi.fn() }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildFailureMessage: vi.fn(),
  buildSuccessMessage: vi.fn(),
  getNotifyConfig: vi.fn(),
}));
vi.mock("../jobs/cancellation", () => ({
  cancelJob: vi.fn(),
  isJobRunning: vi.fn(() => false),
  getLiveDetail: vi.fn(() => null),
  registerJob: vi.fn(),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock("../tg/liveClient", () => ({
  isAuthError: vi.fn(),
  markSessionExpired: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import {
  accountDoc,
  insert,
  jobDoc,
  logDoc,
  syncCounter,
  templateDoc,
  useTestDb,
} from "./helpers/db";


let server: http.Server;
let baseUrl: string;

async function getJson(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

beforeAll(async () => {
  const { default: templatesRouter } = await import("../routes/templates");
  const { default: jobsRouter } = await import("../routes/jobs");
  const { default: accountsRouter } = await import("../routes/accounts");
  const { default: logsRouter } = await import("../routes/logs");

  const app = express();
  app.use(express.json());
  app.use("/templates", templatesRouter);
  app.use("/jobs", jobsRouter);
  app.use("/accounts", accountsRouter);
  app.use("/logs", logsRouter);

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

useTestDb();

beforeEach(() => {
  vi.clearAllMocks();
  templateSeq = 0;
  accountSeq = 0;
  jobSeq = 0;
  logSeq = 0;
});

let templateSeq = 0;
let accountSeq = 0;
let jobSeq = 0;
let logSeq = 0;

/**
 * The ids are chosen rather than read back: the tests refer to them in URLs and in facet
 * assertions. `syncCounter` then tells the sequence about them, so a row created through a
 * repository -- the template-duplicate route does exactly that -- cannot be handed an id
 * these inserts already took.
 */
async function insertTemplate(
  name: string,
  opts: {
    jobType?: string;
    bot?: string;
    enabled?: number;
    config?: string;
    timezone?: string;
    runEveryDays?: number;
    runEveryDaysMax?: number | null;
  } = {},
): Promise<number> {
  const id = ++templateSeq;
  await insert("job_templates", [
    templateDoc({
      _id: id,
      name,
      job_type: opts.jobType ?? "checkin",
      bot_username: opts.bot ?? "",
      enabled: opts.enabled ?? 1,
      config: opts.config ?? null,
      timezone: opts.timezone ?? "Australia/Sydney",
      run_every_days: opts.runEveryDays ?? 1,
      run_every_days_max: opts.runEveryDaysMax ?? null,
    }),
  ]);
  await syncCounter("job_templates", id);
  return id;
}

async function insertAccount(
  name: string,
  opts: { disabled?: number; notes?: string; phone?: string } = {},
): Promise<number> {
  const id = ++accountSeq;
  await insert("tg_accounts", [
    accountDoc({
      _id: id,
      name,
      phone_number: opts.phone ?? "+61",
      disabled: opts.disabled ?? 0,
      notes: opts.notes ?? null,
    }),
  ]);
  await syncCounter("tg_accounts", id);
  return id;
}

async function insertJob(
  name: string,
  opts: {
    accountId?: number | null;
    jobType?: string;
    bot?: string;
    templateId?: number | null;
  } = {},
): Promise<number> {
  const id = ++jobSeq;
  await insert("jobs", [
    jobDoc({
      _id: id,
      name,
      account_id: opts.accountId ?? null,
      job_type: opts.jobType ?? "checkin",
      bot_username: opts.bot ?? "",
      template_id: opts.templateId ?? null,
    }),
  ]);
  await syncCounter("jobs", id);
  return id;
}

async function insertLog(
  jobId: number,
  status: string,
  message: string,
  ranAt: string,
): Promise<number> {
  const id = ++logSeq;
  await insert("job_logs", [
    logDoc({ _id: id, job_id: jobId, ran_at: ranAt, status, message }),
  ]);
  await syncCounter("job_logs", id);
  return id;
}

describe("fuzzyScore", () => {
  it("matches substrings with a high score", () => {
    expect(fuzzyScore("daily", "My Daily Checkin")).toBeGreaterThan(500);
  });

  it("matches subsequences", () => {
    expect(fuzzyScore("dlychk", "daily checkin")).toBeGreaterThan(0);
  });

  it("requires every token to match", () => {
    expect(fuzzyScore("daily bot", "daily checkin @mybot")).toBeGreaterThan(0);
    expect(fuzzyScore("daily zzz", "daily checkin")).toBe(0);
  });

  it("returns 0 when characters are out of order", () => {
    expect(fuzzyScore("xyz", "daily checkin")).toBe(0);
  });

  it("ranks tighter matches higher", () => {
    const tight = fuzzyScore("abc", "abc-template");
    const loose = fuzzyScore("abc", "a1b2c3");
    expect(tight).toBeGreaterThan(loose);
  });
});

describe("GET /templates", () => {
  it("keeps the legacy array shape without paging params", async () => {
    await insertTemplate("Alpha");
    await insertTemplate("Beta");
    const { body } = await getJson("/templates");
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((t: any) => t.name)).toEqual(["Alpha", "Beta"]);
  });

  it("returns a paged envelope with total", async () => {
    for (let i = 1; i <= 7; i++) await insertTemplate(`Tpl ${String(i).padStart(2, "0")}`);
    const { body } = await getJson("/templates?page=2&pageSize=3");
    expect(body.total).toBe(7);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(3);
    expect(body.items.map((t: any) => t.name)).toEqual(["Tpl 04", "Tpl 05", "Tpl 06"]);
  });

  it("fuzzy search filters and ranks by relevance", async () => {
    await insertTemplate("Daily Checkin", { bot: "dailybot" });
    await insertTemplate("Weekly Report", { bot: "weeklybot" });
    await insertTemplate("Dry Cleaner", { bot: "cleanbot" });
    const { body } = await getJson("/templates?page=1&pageSize=10&search=daily");
    const names = body.items.map((t: any) => t.name);
    expect(names[0]).toBe("Daily Checkin");
    expect(names).not.toContain("Weekly Report");
    expect(body.total).toBe(1);
  });

  it("fuzzy search matches subsequences and bot usernames", async () => {
    await insertTemplate("Signin Group", { bot: "sgn_helper" });
    await insertTemplate("Other", { bot: "another" });
    const { body } = await getJson("/templates?page=1&pageSize=10&search=sgnhlp");
    expect(body.items.map((t: any) => t.name)).toEqual(["Signin Group"]);
  });

  it("filters by jobType and enabled", async () => {
    await insertTemplate("A", { jobType: "checkin", enabled: 1 });
    await insertTemplate("B", { jobType: "custom", enabled: 0 });
    const byType = await getJson("/templates?page=1&pageSize=10&jobType=custom");
    expect(byType.body.items.map((t: any) => t.name)).toEqual(["B"]);
    const byEnabled = await getJson("/templates?page=1&pageSize=10&enabled=1");
    expect(byEnabled.body.items.map((t: any) => t.name)).toEqual(["A"]);
  });

  it("sorts by requested column and direction", async () => {
    await insertTemplate("A", { bot: "zbot" });
    await insertTemplate("B", { bot: "abot" });
    const { body } = await getJson("/templates?page=1&pageSize=10&sortKey=botUrl&sortDir=desc");
    expect(body.items.map((t: any) => t.name)).toEqual(["A", "B"]);
  });
});

describe("GET /jobs", () => {
  it("keeps the legacy array shape without paging params", async () => {
    await insertJob("Job A");
    await insertJob("Job B");
    const { body } = await getJson("/jobs");
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it("pages, filters, and reports facets", async () => {
    const acct = await insertAccount("Acct 1");
    const tpl = await insertTemplate("Tpl", { bot: "tplbot" });
    await insertJob("Standalone", { bot: "solobot", jobType: "custom" });
    await insertJob("Linked", { accountId: acct, jobType: "custom", bot: "tplbot", templateId: tpl });
    await insertJob("Other", { accountId: acct, jobType: "checkin", bot: "otherbot" });

    const { body } = await getJson("/jobs?page=1&pageSize=2&sortKey=name");
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(2);
    expect(body.facets.botUsernames).toEqual(["otherbot", "solobot"]);
    expect(body.facets.templates).toEqual([{ id: tpl, name: "Tpl" }]);

    const filtered = await getJson(`/jobs?page=1&pageSize=10&accountId=${acct}&jobType=checkin`);
    expect(filtered.body.items.map((j: any) => j.name)).toEqual(["Other"]);

    const byTemplate = await getJson(`/jobs?page=1&pageSize=10&templateId=${tpl}`);
    expect(byTemplate.body.items.map((j: any) => j.name)).toEqual(["Linked"]);

    const byName = await getJson("/jobs?page=1&pageSize=10&search=stand");
    expect(byName.body.items.map((j: any) => j.name)).toEqual(["Standalone"]);
  });

  it("escapes LIKE wildcards in search", async () => {
    await insertJob("100% real");
    await insertJob("underscored");
    const { body } = await getJson(`/jobs?page=1&pageSize=10&search=${encodeURIComponent("100%")}`);
    expect(body.items.map((j: any) => j.name)).toEqual(["100% real"]);
  });
});

describe("GET /accounts", () => {
  it("keeps the legacy array shape without paging params", async () => {
    await insertAccount("One");
    const { body } = await getJson("/accounts");
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].name).toBe("One");
  });

  it("pages and searches name, phone, and notes", async () => {
    await insertAccount("Primary", { phone: "+6140000", notes: "vip customer" });
    await insertAccount("Backup", { phone: "+6150000" });
    await insertAccount("Spare", { phone: "+6160000", disabled: 1 });

    const paged = await getJson("/accounts?page=1&pageSize=2");
    expect(paged.body.total).toBe(3);
    expect(paged.body.items).toHaveLength(2);

    const byNotes = await getJson("/accounts?page=1&pageSize=10&search=vip");
    expect(byNotes.body.items.map((a: any) => a.name)).toEqual(["Primary"]);

    const byPhone = await getJson("/accounts?page=1&pageSize=10&search=615");
    expect(byPhone.body.items.map((a: any) => a.name)).toEqual(["Backup"]);

    const activeOnly = await getJson("/accounts?page=1&pageSize=10&disabled=0");
    expect(activeOnly.body.total).toBe(2);
  });
});

describe("GET /logs", () => {
  it("keeps the legacy array shape with limit/offset", async () => {
    const job = await insertJob("Job A");
    await insertLog(job, "success", "ok", "2026-07-01T00:00:00Z");
    await insertLog(job, "failed", "boom", "2026-07-02T00:00:00Z");
    const { body } = await getJson("/logs?limit=1&offset=0");
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].message).toBe("boom");
  });

  it("pages with total and filters by status and search", async () => {
    const jobA = await insertJob("Alpha Job");
    const jobB = await insertJob("Beta Job");
    await insertLog(jobA, "success", "all good", "2026-07-01T00:00:00Z");
    await insertLog(jobA, "failed", "timeout waiting", "2026-07-02T00:00:00Z");
    await insertLog(jobB, "failed", "button not found", "2026-07-03T00:00:00Z");

    const paged = await getJson("/logs?page=1&pageSize=2");
    expect(paged.body.total).toBe(3);
    expect(paged.body.items).toHaveLength(2);
    expect(paged.body.items[0].message).toBe("button not found");

    const failedOnly = await getJson("/logs?page=1&pageSize=10&status=failed");
    expect(failedOnly.body.total).toBe(2);

    const bySearch = await getJson("/logs?page=1&pageSize=10&search=beta");
    expect(bySearch.body.items.map((l: any) => l.message)).toEqual(["button not found"]);

    const byMessage = await getJson("/logs?page=1&pageSize=10&search=timeout");
    expect(byMessage.body.items.map((l: any) => l.message)).toEqual(["timeout waiting"]);
  });
});

describe("POST /templates/:id/duplicate", () => {
  it("copies every configured field onto a new template", async () => {
    const cfg = JSON.stringify({ actions: [{ type: "open_mini_app_url", url: "https://x/app" }] });
    const id = await insertTemplate("Daily Draw", {
      jobType: "custom",
      bot: "drawbot",
      config: cfg,
      timezone: "Australia/Sydney",
      runEveryDays: 3,
      runEveryDaysMax: 5,
    });

    const { status, body } = await postJson(`/templates/${id}/duplicate`);
    expect(status).toBe(201);
    expect(body.id).not.toBe(id);
    expect(body.name).toBe("Daily Draw (copy)");
    expect(body.jobType).toBe("custom");
    expect(body.botUsername).toBe("drawbot");
    expect(body.config).toBe(cfg);
    expect(body.timezone).toBe("Australia/Sydney");
    expect(body.runEveryDays).toBe(3);
    expect(body.runEveryDaysMax).toBe(5);

    const all = await getJson("/templates");
    expect(all.body.map((t: any) => t.name)).toEqual(["Daily Draw", "Daily Draw (copy)"]);
  });

  it("numbers further copies rather than repeating the name", async () => {
    const id = await insertTemplate("Alpha");
    const first = await postJson(`/templates/${id}/duplicate`);
    const second = await postJson(`/templates/${id}/duplicate`);
    const third = await postJson(`/templates/${first.body.id}/duplicate`);
    expect(first.body.name).toBe("Alpha (copy)");
    expect(second.body.name).toBe("Alpha (copy 2)");
    expect(third.body.name).toBe("Alpha (copy) (copy)");
  });

  it("leaves the source's linked jobs with the source", async () => {
    const tpl = await insertTemplate("Linked");
    await insertJob("Job A", { templateId: tpl });
    const { body } = await postJson(`/templates/${tpl}/duplicate`);

    const paged = await getJson("/templates?page=1&pageSize=10");
    const rows = Object.fromEntries(
      paged.body.items.map((t: any) => [t.id, t.linkedJobCount]),
    );
    expect(rows[tpl]).toBe(1);
    expect(rows[body.id]).toBe(0);
  });

  it("404s for a template that does not exist", async () => {
    const { status } = await postJson("/templates/9999/duplicate");
    expect(status).toBe(404);
  });
});

// `pageSize=0` is the "All" choice in the list views: one page, no ceiling -- including
// past the 200-row cap the numbered page sizes are clamped to.
describe("page size All (pageSize=0)", () => {
  it("returns every template on one page, beyond the usual cap", async () => {
    for (let i = 1; i <= 205; i++) await insertTemplate(`Tpl ${String(i).padStart(3, "0")}`);
    const { body } = await getJson("/templates?page=1&pageSize=0");
    expect(body.total).toBe(205);
    expect(body.items).toHaveLength(205);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(0);
  });

  it("returns every job, account, and log on one page", async () => {
    for (let i = 1; i <= 5; i++) await insertAccount(`Acct ${i}`);
    const job = await insertJob("Job A");
    for (let i = 1; i <= 5; i++) await insertJob(`Job ${i}`);
    for (let i = 1; i <= 5; i++)
      await insertLog(job, "success", `run ${i}`, `2026-07-0${i}T00:00:00Z`);

    const jobs = await getJson("/jobs?page=1&pageSize=0");
    expect(jobs.body.items).toHaveLength(6);
    const accounts = await getJson("/accounts?page=1&pageSize=0");
    expect(accounts.body.items).toHaveLength(5);
    const logs = await getJson("/logs?page=1&pageSize=0");
    expect(logs.body.items).toHaveLength(5);
  });

  it("ignores the page number, since All is a single page", async () => {
    for (let i = 1; i <= 5; i++) await insertTemplate(`Tpl ${i}`);
    const { body } = await getJson("/templates?page=3&pageSize=0");
    expect(body.page).toBe(1);
    expect(body.items).toHaveLength(5);
  });

  it("still keeps the legacy array shape when no paging param is sent", async () => {
    await insertTemplate("Alpha");
    const { body } = await getJson("/templates");
    expect(Array.isArray(body)).toBe(true);
  });
});
