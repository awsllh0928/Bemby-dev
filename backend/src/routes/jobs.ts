import { Router } from "express";
import type { Filter, Sort } from "mongodb";
import { getDefaultTgApiCredentials } from "../db/database";
import { col } from "../db/collection";
import { NOCASE, buildSort, like } from "../db/query";
import type { AccountDoc, JobDoc, JobTemplateDoc } from "../db/types";
import { countJobs, createJob, getJob, NOT_RETIRED, updateJob } from "../db/repos/jobs";
import { getAccount } from "../db/repos/accounts";
import { runStarted, updateLog } from "../db/repos/logs";
import { decryptAccountRow } from "../db/secretColumns";
import { runJob, type JobDetailLog } from "../jobs/runner";
import { collectRunWarnings, completedMessage } from "../jobs/runWarnings";
import {
  notifyJobEvent,
  buildFailureMessage,
  buildSuccessMessage,
} from "../jobs/notify";
import { refreshScheduler } from "../scheduler";
import type { Job, TgAccount } from "../types";
import { registerJob, unregisterJob, registerLiveDetail, clearLiveDetail } from "../jobs/cancellation";
import { testEmbyConnection } from "../jobs/embywatch";
import { parsePaging, textParam } from "./list-query";

const router = Router();

/** A job plus the name of the account it runs under, which the list joins in. */
type JobRow = JobDoc & { account_name?: string | null };

type AccountRow = AccountDoc;

/** Loads a job together with its account name, the way the old LEFT JOIN returned it. */
async function loadJobRow(id: number): Promise<JobRow | null> {
  const job = await getJob(id);
  if (!job) return null;
  const account = job.account_id != null ? await getAccount(job.account_id) : null;
  return { ...job, account_name: account?.name };
}

/** Credentials are resolved as a pair: the account's own if complete, else the global defaults. */
async function rowToAccount(row: AccountRow): Promise<TgAccount> {
  const ownCredentials =
    row.api_id && row.api_hash
      ? { apiId: row.api_id, apiHash: row.api_hash }
      : null;
  const credentials = ownCredentials ?? (await getDefaultTgApiCredentials());
  return {
    id: row._id,
    name: row.name,
    phoneNumber: row.phone_number,
    apiId: credentials?.apiId ?? null,
    apiHash: credentials?.apiHash ?? null,
    sessionString: row.session_string,
    authStatus: row.auth_status as TgAccount["authStatus"],
    proxyId: row.proxy_id ?? null,
    disabled: Boolean(row.disabled),
    appClientId: row.app_client_id ?? null,
    createdAt: row.created_at,
  };
}

// Normalise a run-every-days range: min is clamped to >= 1; max is kept only
// when it is a valid integer strictly greater than min, otherwise null (fixed).
export function normalizeRunEvery(min: unknown, max: unknown): { min: number; max: number | null } {
  const lo = Math.max(1, Math.floor(Number(min ?? 1)) || 1);
  const hiNum = max == null || max === "" ? NaN : Math.floor(Number(max));
  const hi = Number.isFinite(hiNum) && hiNum > lo ? hiNum : null;
  return { min: lo, max: hi };
}

function rowToJob(row: JobRow): Job & { accountName?: string | null } {
  return {
    id: row._id,
    name: row.name,
    accountId: row.account_id ?? null,
    accountName: row.account_name,
    jobType: row.job_type as Job["jobType"],
    botUsername: row.bot_username,
    scheduleWindowStart: row.schedule_window_start,
    scheduleWindowEnd: row.schedule_window_end,
    timezone: row.timezone,
    replyTimeoutMs: row.reply_timeout_ms,
    retryMax: row.retry_max,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    config: row.config ?? null,
    startCommand: row.start_command || "/start",
    checkinButton: row.checkin_button || "签到",
    templateId: row.template_id ?? null,
    runEveryDays: row.run_every_days ?? 1,
    runEveryDaysMax: row.run_every_days_max ?? null,
    retired: row.retired ?? null,
    lastSuccessAt: row.last_success_at ?? null,
  };
}

/** The list view's sort columns, as Mongo sort specs. Every one carries `name` as a
 *  tiebreaker so paging through equal values stays stable. */
const JOB_SORTS: Record<string, Sort> = {
  name: { name: 1 },
  account: { account_name: 1, name: 1 },
  type: { job_type: 1, name: 1 },
  botUrl: { bot_username: 1, name: 1 },
  window: { schedule_window_start: 1, name: 1 },
  // asc shows enabled jobs first, matching the previous client-side sort
  enabled: { enabled: -1, name: 1 },
  // asc puts never-succeeded jobs first, then oldest success
  lastSuccess: { last_success_at: 1, name: 1 },
};

router.get("/", async (req, res) => {
  try {
    const query = req.query as Record<string, unknown>;
    const paging = parsePaging(query);
    const search = textParam(query.search);
    const jobType = textParam(query.jobType);
    const accountId = textParam(query.accountId);
    const botUsername = textParam(query.botUsername);
    const templateId = textParam(query.templateId);
    const enabled = textParam(query.enabled);

    const conditions: Array<Filter<JobDoc>> = [NOT_RETIRED];

    if (search) conditions.push({ name: like(search) });
    if (jobType) conditions.push({ job_type: jobType });
    if (accountId) {
      const parsed = Number(accountId);
      if (!Number.isInteger(parsed)) {
        res.status(400).json({ error: "Invalid accountId" });
        return;
      }
      conditions.push({ account_id: parsed });
    }
    if (botUsername) conditions.push({ bot_username: botUsername });
    if (templateId) {
      const parsed = Number(templateId);
      if (!Number.isInteger(parsed)) {
        res.status(400).json({ error: "Invalid templateId" });
        return;
      }
      conditions.push({ template_id: parsed });
    }
    if (enabled === "1" || enabled === "0") {
      conditions.push({ enabled: Number(enabled) });
    }
    const filter: Filter<JobDoc> = { $and: conditions };

    // The account name arrives through a $lookup rather than second query because the list
    // can sort on it. NOCASE gives the case-insensitive ordering COLLATE NOCASE provided;
    // it also loosens the string equality filters above, which only ever match more.
    const pipeline: Record<string, unknown>[] = [
      { $match: filter },
      {
        $lookup: {
          from: "tg_accounts",
          localField: "account_id",
          foreignField: "_id",
          as: "account",
        },
      },
      { $unwind: { path: "$account", preserveNullAndEmptyArrays: true } },
      { $addFields: { account_name: "$account.name" } },
      { $project: { account: 0 } },
      {
        $sort: buildSort(
          textParam(query.sortKey) || undefined,
          query.sortDir,
          JOB_SORTS,
          JOB_SORTS.name,
        ),
      },
    ];
    if (paging) {
      pipeline.push({ $skip: paging.offset });
      // "All" is one unbounded page: a $limit with a negative value has no equivalent.
      if (paging.limit > 0) pipeline.push({ $limit: paging.limit });
    }

    const rows = (await col<JobDoc>("jobs")
      .aggregate(pipeline, { collation: NOCASE })
      .toArray()) as JobRow[];

    if (!paging) {
      res.json(rows.map(rowToJob));
      return;
    }

    // Facets let the client build filter dropdowns without loading every row
    const botRows = await col<JobDoc>("jobs")
      .aggregate([
        {
          $match: {
            ...NOT_RETIRED,
            template_id: null,
            bot_username: { $ne: "" },
          },
        },
        { $group: { _id: "$bot_username" } },
        { $sort: { _id: 1 } },
      ], { collation: NOCASE })
      .toArray();
    const usedTemplateIds = (
      await col<JobDoc>("jobs").distinct("template_id", NOT_RETIRED)
    ).filter((id): id is number => id != null);
    const templatesInUse = usedTemplateIds.length
      ? (
          await col<JobTemplateDoc>("job_templates")
            .find({ _id: { $in: usedTemplateIds } })
            .sort({ name: 1 })
            .collation(NOCASE)
            .toArray()
        ).map((t) => ({ id: t._id, name: t.name }))
      : [];

    res.json({
      items: rows.map(rowToJob),
      total: await countJobs(filter),
      page: paging.page,
      pageSize: paging.pageSize,
      facets: {
        botUsernames: botRows.map((r) => r._id as string),
        templates: templatesInUse,
      },
    });
  } catch (e) {
    console.error("[jobs] list failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Verify Emby server reachability and credentials without creating a job
router.post("/test-emby", async (req, res) => {
  const { serverUrl, username, password, userAgent, proxyId } = req.body as Record<
    string,
    string | undefined
  >;
  if (!serverUrl || !username || !password) {
    res
      .status(400)
      .json({ error: "serverUrl, username and password are required" });
    return;
  }
  if (!/^https?:\/\//i.test(serverUrl)) {
    res
      .status(400)
      .json({ error: "serverUrl must start with http:// or https://" });
    return;
  }
  const result = await testEmbyConnection(serverUrl, {
    username,
    password,
    userAgent,
    proxyId,
  });
  res.json(result);
});

router.post("/", async (req, res) => {
  try {
    const {
      name,
      accountId,
      jobType,
      botUsername,
      scheduleWindowStart,
      scheduleWindowEnd,
      timezone,
      replyTimeoutMs,
      retryMax,
      enabled,
      config,
      startCommand,
      checkinButton,
      templateId,
      runEveryDays,
      runEveryDaysMax,
    } = req.body as Record<string, any>;

    const resolvedType = jobType ?? "checkin";
    const needsAccount =
      resolvedType === "checkin" ||
      resolvedType === "custom" ||
      resolvedType === "autoreg";
    // A custom job need not target a bot at all: its actions can each name their own
    // contact, or drive a page that never touches Telegram.
    if (!name || (needsAccount && !accountId) || (resolvedType !== "custom" && !botUsername)) {
      res.status(400).json({
        error:
          "name is required; botUsername is required for every type except custom; " +
          "accountId is required for checkin, custom and autoreg jobs",
      });
      return;
    }

    const runEvery = normalizeRunEvery(runEveryDays, runEveryDaysMax);
    const id = await createJob({
      name,
      account_id: accountId ? Number(accountId) : null,
      job_type: resolvedType,
      bot_username: (botUsername as string).replace(/^@+/, ""),
      schedule_window_start: Number(scheduleWindowStart ?? 1400),
      schedule_window_end: Number(scheduleWindowEnd ?? 1600),
      timezone: timezone ?? "",
      reply_timeout_ms: Number(replyTimeoutMs ?? 40000),
      retry_max: Number(retryMax ?? 5),
      enabled: enabled !== false ? 1 : 0,
      config: config != null ? JSON.stringify(config) : null,
      start_command: (startCommand as string | undefined)?.trim() || "/start",
      checkin_button: (checkinButton as string | undefined)?.trim() || "签到",
      template_id: templateId ? Number(templateId) : null,
      run_every_days: runEvery.min,
      run_every_days_max: runEvery.max,
    });

    const row = await loadJobRow(id);
    refreshScheduler();
    res.status(201).json(rowToJob(row as JobRow));
  } catch (e) {
    console.error("[jobs] create failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await getJob(id);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const {
      name,
      accountId,
      jobType,
      botUsername,
      scheduleWindowStart,
      scheduleWindowEnd,
      timezone,
      replyTimeoutMs,
      retryMax,
      enabled,
      config,
      startCommand,
      checkinButton,
      templateId,
      runEveryDays,
      runEveryDaysMax,
    } = req.body as Record<string, any>;

    // When linked to a template, template-controlled fields are read-only
    const isLinked = existing.template_id != null && templateId === undefined;
    const resolvedTemplateId = templateId !== undefined
      ? (templateId ? Number(templateId) : null)
      : existing.template_id;

    const updatedType = isLinked ? existing.job_type : (jobType ?? existing.job_type);
    const runEvery = normalizeRunEvery(
      runEveryDays !== undefined ? runEveryDays : existing.run_every_days,
      runEveryDaysMax !== undefined ? runEveryDaysMax : existing.run_every_days_max,
    );
    await updateJob(id, {
      name: name ?? existing.name,
      account_id:
        accountId !== undefined ? (accountId ? Number(accountId) : null) : (existing.account_id ?? null),
      job_type: updatedType,
      bot_username: isLinked
        ? existing.bot_username
        : ((botUsername as string | undefined)?.replace(/^@+/, "") ?? existing.bot_username),
      schedule_window_start: Number(scheduleWindowStart ?? existing.schedule_window_start),
      schedule_window_end: Number(scheduleWindowEnd ?? existing.schedule_window_end),
      timezone: isLinked ? existing.timezone : (timezone ?? existing.timezone),
      reply_timeout_ms: isLinked
        ? existing.reply_timeout_ms
        : Number(replyTimeoutMs ?? existing.reply_timeout_ms),
      retry_max: isLinked ? existing.retry_max : Number(retryMax ?? existing.retry_max),
      enabled: enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      // embywatch template-linked jobs store credentials in the job; allow config updates
      config:
        isLinked && existing.job_type !== "embywatch"
          ? existing.config
          : config !== undefined
            ? config != null
              ? JSON.stringify(config)
              : null
            : existing.config,
      start_command: isLinked
        ? existing.start_command
        : startCommand !== undefined
          ? (startCommand as string).trim() || "/start"
          : existing.start_command,
      checkin_button: isLinked
        ? existing.checkin_button
        : checkinButton !== undefined
          ? (checkinButton as string).trim() || "签到"
          : existing.checkin_button,
      template_id: resolvedTemplateId,
      run_every_days: runEvery.min,
      run_every_days_max: runEvery.max,
    });

    const row = await loadJobRow(id);
    refreshScheduler();
    res.json(rowToJob(row as JobRow));
  } catch (e) {
    console.error("[jobs] update failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    // Soft delete: `retired` was `datetime('now')` in SQLite, kept as an ISO stamp here.
    await updateJob(Number(req.params.id), { retired: new Date().toISOString() });
    refreshScheduler();
    res.status(204).send();
  } catch (e) {
    console.error("[jobs] retire failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Manual trigger
router.post("/:id/run", async (req, res) => {
  try {
    const jobRow = await getJob(Number(req.params.id));
    if (!jobRow) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const job = rowToJob(jobRow);
    let account: TgAccount | null = null;

    if (job.jobType === "checkin" || job.jobType === "custom" || job.jobType === "autoreg") {
      const accountRow = jobRow.account_id != null
        ? await getAccount(jobRow.account_id)
        : null;
      if (accountRow) decryptAccountRow(accountRow);
      if (!accountRow?.session_string) {
        res.status(400).json({ error: "Account is not authenticated" });
        return;
      }
      account = await rowToAccount(accountRow);
      if (!account.apiId || !account.apiHash) {
        res.status(400).json({
          error:
            "No API credentials available for this account. Add credentials to the account or configure global defaults in Settings.",
        });
        return;
      }
    } else if (job.accountId) {
      // Optional linked account (e.g. embywatch) — used for notifications only; don't block if not authenticated
      const accountRow = await getAccount(job.accountId);
      if (accountRow) decryptAccountRow(accountRow);
      if (accountRow?.session_string) {
        account = await rowToAccount(accountRow);
      }
    }

    const ranAt = new Date().toISOString();
    const logId = await runStarted(job.id, { source: "manual", message: "Manual run" });

    res.json({ message: "Job triggered", logId });

    const detailLogs: JobDetailLog[] = [];
    const signal = registerJob(Number(logId));
    registerLiveDetail(Number(logId), detailLogs);
    runJob(job, account, detailLogs, signal)
      .then(async () => {
        const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
        const warnings = collectRunWarnings(job.jobType, detailLogs);
        await updateLog(logId, {
          status: "success",
          message: completedMessage(warnings),
          detail,
        });
        // Durable stamp; job_logs is pruned by log_retention_days. Only moves
        // forward so a slow run finishing after a later one can't rewind it.
        // Isolated: a failure here must not demote an otherwise successful run.
        try {
          await col<JobDoc>("jobs").updateOne(
            {
              _id: job.id,
              $or: [{ last_success_at: null }, { last_success_at: { $lt: ranAt } }],
            },
            { $set: { last_success_at: ranAt } },
          );
        } catch (e) {
          console.warn(`[jobs] "${job.name}" last_success_at stamp failed:`, e);
        }
        void notifyJobEvent(
          "success",
          buildSuccessMessage(job.name, job.jobType),
          account,
        );
      })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const isCancelled = message === "Job cancelled";
        const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
        await updateLog(logId, {
          status: "failed",
          message: isCancelled ? "Cancelled" : message,
          detail,
        });
        if (!isCancelled) {
          void notifyJobEvent(
            "failed",
            buildFailureMessage(job.name, job.jobType, message),
            account,
          );
        }
      })
      .finally(() => { unregisterJob(Number(logId)); clearLiveDetail(Number(logId)); });
  } catch (e) {
    console.error("[jobs] run failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
