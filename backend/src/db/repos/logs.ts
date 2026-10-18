import type { Filter, Sort } from "mongodb";

import { col } from "../collection";
import { getDb } from "../mongo/client";
import { NOCASE, buildSort, like } from "../query";
import { nextId } from "../mongo/ids";
import type { AccountDoc, JobDoc, JobLogDoc } from "../types";

function logsCol() {
  return col<JobLogDoc>("job_logs");
}

/** `retired` was INTEGER 0/1 in SQLite. 0 was never written explicitly by the list query --
 *  it filtered on `l.retired = 0` -- and rows inserted without the column defaulted to 0, so
 *  both 0 and an absent field mean "live". */
export const NOT_RETIRED: Filter<JobLogDoc> = { retired: { $ne: 1 } };

const SORTS: Record<string, Sort> = {
  ran_at: { ran_at: -1 },
  date: { ran_at: -1 },
  created: { ran_at: -1 },
  status: { status: 1, ran_at: -1 },
  job: { job_id: 1, ran_at: -1 },
};

export function logSort(key: string | undefined, order: unknown): Sort {
  return buildSort(key, order, SORTS, SORTS.ran_at);
}

export function logCollation() {
  return NOCASE;
}

export async function getLog(id: number): Promise<JobLogDoc | null> {
  return logsCol().findOne({ _id: id });
}

/**
 * A log row with the job and account names beside it.
 *
 * SQLite got these with two LEFT JOINs. Mongo does it with two $lookups, which matters in one
 * direction: a `localField`/`foreignField` pair here already tolerates a missing job (the log
 * survives a job deletion -- see deleteJob), whereas the SQL version relied on the join simply
 * producing NULLs. Same result, so nothing downstream changes.
 */
export type LogRow = JobLogDoc & {
  job_name?: string | null;
  job_type?: string | null;
  account_name?: string | null;
};

const JOIN_PIPELINE: Record<string, unknown>[] = [
  {
    $lookup: {
      from: "jobs",
      localField: "job_id",
      foreignField: "_id",
      as: "job",
    },
  },
  { $unwind: { path: "$job", preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: "tg_accounts",
      localField: "job.account_id",
      foreignField: "_id",
      as: "account",
    },
  },
  { $unwind: { path: "$account", preserveNullAndEmptyArrays: true } },
  {
    $addFields: {
      job_name: "$job.name",
      job_type: "$job.job_type",
      account_name: "$account.name",
    },
  },
  { $project: { job: 0, account: 0 } },
];

/** Builds the joined-and-filtered list. `stage` is a Mongo pipeline; callers supply the
 *  `$match` that their query params produce. */
export async function listLogsJoined(
  match: Filter<JobLogDoc>,
  sort?: Sort,
  skip?: number,
  limit?: number,
): Promise<LogRow[]> {
  const pipeline: Record<string, unknown>[] = [{ $match: match }, ...JOIN_PIPELINE];
  if (sort) pipeline.push({ $sort: sort });
  if (skip) pipeline.push({ $skip: skip });
  if (typeof limit === "number") pipeline.push({ $limit: limit });
  return (await logsCol().aggregate(pipeline).toArray()) as LogRow[];
}

export async function countLogsJoined(match: Filter<JobLogDoc>): Promise<number> {
  const pipeline: Record<string, unknown>[] = [{ $match: match }, ...JOIN_PIPELINE, { $count: "total" }];
  const rows = await logsCol().aggregate(pipeline).toArray();
  return (rows[0]?.total as number) ?? 0;
}

/** Search across the joined names, which SQLite did with LIKE against j.name / a.name /
 *  l.message. Done here against the log itself plus whatever names are resolvable. */
/**
 * Ids of the jobs whose own name, or whose account's name, matches.
 *
 * The log list's `$match` runs before the `$lookup` that attaches the job and the account, so
 * a name cannot be filtered on directly -- the field does not exist yet at that point. The
 * names are resolved here and matched as ids instead.
 */
async function jobIdsMatchingName(
  pattern: { $regex: string; $options: string },
): Promise<number[]> {
  const [byJobName, accounts] = await Promise.all([
    col<JobDoc>("jobs").find({ name: pattern }, { projection: { _id: 1 } }).toArray(),
    col<AccountDoc>("tg_accounts")
      .find({ name: pattern }, { projection: { _id: 1 } })
      .toArray(),
  ]);

  const accountIds = accounts.map((a) => a._id);
  const byAccountName = accountIds.length
    ? await col<JobDoc>("jobs")
        .find({ account_id: { $in: accountIds } }, { projection: { _id: 1 } })
        .toArray()
    : [];

  return [...new Set([...byJobName, ...byAccountName].map((j) => j._id))];
}

/**
 * Builds the `$match` for the log list.
 *
 * Async because the search reaches the joined names: SQLite's query covered `j.name`,
 * `a.name` and `l.message`, and losing the first two would mean a search for a job's name
 * found nothing at all.
 */
export async function buildLogMatch(opts: {
  jobId?: number;
  status?: string;
  retired?: boolean;
  search?: string;
}): Promise<Filter<JobLogDoc>> {
  const conditions: Filter<JobLogDoc>[] = [];
  if (opts.jobId) conditions.push({ job_id: opts.jobId });
  if (opts.status) conditions.push({ status: opts.status });
  // Retired rows are normally hidden; passing retired:true asks for them instead.
  if (!opts.retired) conditions.push(NOT_RETIRED);
  if (opts.search) {
    const pattern = like(opts.search);
    const jobIds = await jobIdsMatchingName(pattern);
    conditions.push({
      $or: [
        { message: pattern },
        { status: pattern },
        ...(jobIds.length ? [{ job_id: { $in: jobIds } }] : []),
      ],
    } as Filter<JobLogDoc>);
  }
  if (!conditions.length) return {};
  return conditions.length === 1 ? conditions[0] : { $and: conditions };
}

export async function updateLog(
  id: number,
  patch: Partial<Omit<JobLogDoc, "_id">>,
): Promise<void> {
  if (!Object.keys(patch).length) return;
  await logsCol().updateOne({ _id: id }, { $set: patch });
}

export async function updateLogs(
  filter: Filter<JobLogDoc>,
  patch: Partial<Omit<JobLogDoc, "_id">>,
): Promise<number> {
  const result = await logsCol().updateMany(filter, { $set: patch });
  return result.modifiedCount;
}

export async function setRetired(id: number, retired: boolean): Promise<void> {
  await logsCol().updateOne({ _id: id }, { $set: { retired: retired ? 1 : 0 } });
}

/** Last run time for a job, optionally by status. Used by the scheduler to decide whether a
 *  job already ran today. */
export async function latestRunAt(
  jobId: number,
  status?: string,
): Promise<string | null> {
  const filter: Filter<JobLogDoc> = status ? { job_id: jobId, status } : { job_id: jobId };
  const rows = await logsCol().find(filter).sort({ ran_at: -1 }).limit(1).toArray();
  return rows[0]?.ran_at ?? null;
}

export async function runStarted(jobId: number, opts?: { source?: string; message?: string }) {
  const id = await nextId(getDb(), "job_logs");
  await logsCol().insertOne({
    _id: id,
    job_id: jobId,
    ran_at: new Date().toISOString(),
    status: "running",
    message: opts?.message ?? null,
    source: opts?.source ?? "scheduler",
    retired: 0,
    detail: null,
  } as JobLogDoc);
  return id;
}

/** Marks every `running` row as failed. Used at boot for runs interrupted by a restart or an
 *  OOM kill, which cannot record anything on the way out. */
export async function failRunningLogs(message: string): Promise<number> {
  const result = await logsCol().updateMany(
    { status: "running" },
    { $set: { status: "failed", message } },
  );
  return result.modifiedCount;
}

/**
 * Purges logs older than the retention window.
 *
 * `ran_at` is an ISO string, which sorts lexicographically exactly as it does chronologically
 * -- that is the whole reason ISO-8601 UTC was chosen for this column.
 */
export async function purgeLogsOlderThan(cutoffIso: string): Promise<number> {
  const result = await logsCol().deleteMany({ ran_at: { $lt: cutoffIso } });
  return result.deletedCount ?? 0;
}
