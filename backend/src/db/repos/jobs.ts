import type { Filter, Sort } from "mongodb";

import { col } from "../collection";
import { getDb } from "../mongo/client";
import { nextId } from "../mongo/ids";
import { NOCASE, buildSort, like } from "../query";
import type { JobDoc } from "../types";

function jobsCol() {
  return col<JobDoc>("jobs");
}

export type JobSortKey = "name" | "type" | "account" | "enabled" | "created";

/**
 * The job list's sort columns. `retired, enabled, name` was served by one SQLite index; in
 * Mongo it is two fields here plus whatever the caller filters on, because an index cannot
 * stand in for a sort it does not prefix.
 */
const SORTS: Record<string, Sort> = {
  name: { name: 1 },
  type: { job_type: 1, name: 1 },
  enabled: { enabled: -1, name: 1 },
  created: { created_at: -1, _id: -1 },
  retired: { retired: 1, enabled: 1, name: 1 },
};

export function jobSort(key: string | undefined, order: unknown): Sort {
  return buildSort(key, order, SORTS, { retired: 1, enabled: 1, name: 1 });
}

export function jobCollation(key: string | undefined) {
  return key === "name" ? NOCASE : undefined;
}

/** `retired IS NULL` -- Mongo's `{ retired: null }` already matches a missing field, which is
 *  exactly what SQLite's NULL meant here. */
export const NOT_RETIRED: Filter<JobDoc> = { retired: null };

export function searchFilter(search: string | undefined): Filter<JobDoc>["$or"] {
  if (!search) return undefined;
  const pattern = like(search);
  return [{ name: pattern }, { bot_username: pattern }];
}

export async function getJob(id: number): Promise<JobDoc | null> {
  return jobsCol().findOne({ _id: id });
}

export async function listJobs(filter: Filter<JobDoc> = {}): Promise<JobDoc[]> {
  return jobsCol().find(filter).toArray();
}

export async function countJobs(filter: Filter<JobDoc> = {}): Promise<number> {
  return jobsCol().countDocuments(filter);
}

export async function getJobsForTemplate(templateId: number): Promise<JobDoc[]> {
  return jobsCol().find({ template_id: templateId }).toArray();
}

export async function getJobsForAccount(accountId: number): Promise<JobDoc[]> {
  return jobsCol().find({ account_id: accountId }).toArray();
}

export type CreateJobInput = Omit<JobDoc, "_id" | "created_at"> & {
  created_at?: string;
};

export async function createJob(input: CreateJobInput): Promise<number> {
  const id = await nextId(getDb(), "jobs");
  await jobsCol().insertOne({
    ...input,
    _id: id,
    created_at: input.created_at ?? new Date().toISOString(),
  } as JobDoc);
  return id;
}

export async function updateJob(id: number, patch: Partial<Omit<JobDoc, "_id">>): Promise<void> {
  if (!Object.keys(patch).length) return;
  await jobsCol().updateOne({ _id: id }, { $set: patch });
}

export async function updateJobsByTemplate(
  templateId: number,
  patch: Partial<Omit<JobDoc, "_id">>,
): Promise<number> {
  const result = await jobsCol().updateMany({ template_id: templateId }, { $set: patch });
  return result.modifiedCount;
}

/**
 * Deletes a job and everything that only made sense beside it.
 *
 * `job_logs.job_id` was `REFERENCES jobs(id) ON DELETE CASCADE` in SQLite. Without that here,
 * deleting a job would leave its logs orphaned -- visible forever in the log list with nothing
 * to say which job produced them, and impossible to purge.
 */
export async function deleteJob(id: number): Promise<void> {
  await jobsCol().deleteOne({ _id: id });
  await col("job_logs").deleteMany({ job_id: id });
}
