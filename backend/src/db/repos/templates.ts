import { col } from "../collection";
import { getDb } from "../mongo/client";
import { nextId } from "../mongo/ids";
import type { JobTemplateDoc } from "../types";

function templatesCol() {
  return col<JobTemplateDoc>("job_templates");
}

export async function getTemplate(id: number): Promise<JobTemplateDoc | null> {
  return templatesCol().findOne({ _id: id });
}

export async function listTemplates(): Promise<JobTemplateDoc[]> {
  return templatesCol().find({}).toArray();
}

export async function allTemplateNames(): Promise<string[]> {
  const rows = await templatesCol().find({}, { projection: { name: 1 } }).toArray();
  return rows.map((r) => r.name);
}

export type CreateTemplateInput = Omit<JobTemplateDoc, "_id" | "created_at"> & {
  created_at?: string;
};

export async function createTemplate(input: CreateTemplateInput): Promise<number> {
  const id = await nextId(getDb(), "job_templates");
  await templatesCol().insertOne({
    ...input,
    _id: id,
    created_at: input.created_at ?? new Date().toISOString(),
  } as JobTemplateDoc);
  return id;
}

export async function updateTemplate(
  id: number,
  patch: Partial<Omit<JobTemplateDoc, "_id">>,
): Promise<void> {
  if (!Object.keys(patch).length) return;
  await templatesCol().updateOne({ _id: id }, { $set: patch });
}

/**
 * Deletes a template and unlinks its jobs.
 *
 * SQLite declared `jobs.template_id` as ON DELETE SET NULL, so removing a template left the
 * jobs running as plain standalone jobs. That behaviour is reproduced explicitly: without it
 * every job spawned from the template would carry a template_id that answers nothing, and
 * the next "sync from template" would write configuration from a row that no longer exists.
 */
export async function deleteTemplate(id: number): Promise<void> {
  await templatesCol().deleteOne({ _id: id });
  await col("jobs").updateMany({ template_id: id }, { $set: { template_id: null } });
}

/** How many live jobs each template currently has, keyed by template id. Used by the list
 *  endpoint, which showed it as a `linked_job_count` column. */
export async function linkedJobCounts(): Promise<Map<number, number>> {
  const rows = await col<{ _id: number | null; count: number }>("jobs")
    .aggregate([
      { $match: { template_id: { $ne: null, $exists: true } } },
      { $group: { _id: "$template_id", count: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(rows.filter((r) => r._id != null).map((r) => [r._id as number, r.count]));
}
