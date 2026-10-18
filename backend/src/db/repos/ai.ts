import { col } from "../collection";
import { getDb } from "../mongo/client";
import { nextId } from "../mongo/ids";
import type { AiModelDoc, AiSupplierDoc } from "../types";

function suppliersCol() {
  return col<AiSupplierDoc>("ai_suppliers");
}

function modelsCol() {
  return col<AiModelDoc>("ai_models");
}

export async function listSuppliers(): Promise<AiSupplierDoc[]> {
  return suppliersCol().find({}).sort({ _id: 1 }).toArray();
}

export async function getSupplier(id: number): Promise<AiSupplierDoc | null> {
  return suppliersCol().findOne({ _id: id });
}

export async function countSuppliersWithKey(): Promise<number> {
  return suppliersCol().countDocuments({ api_key: { $ne: "" } });
}

export async function createSupplier(input: {
  name: string;
  base_url: string;
  api_key?: string;
  timeout_ms?: number;
}): Promise<number> {
  const id = await nextId(getDb(), "ai_suppliers");
  await suppliersCol().insertOne({
    _id: id,
    name: input.name,
    base_url: input.base_url,
    api_key: input.api_key ?? "",
    timeout_ms: input.timeout_ms ?? 25000,
  } as AiSupplierDoc);
  return id;
}

export async function updateSupplier(
  id: number,
  patch: Partial<Omit<AiSupplierDoc, "_id">>,
): Promise<void> {
  if (!Object.keys(patch).length) return;
  await suppliersCol().updateOne({ _id: id }, { $set: patch });
}

/**
 * Deletes a supplier and its models.
 *
 * `ai_models.supplier_id` was `ON DELETE CASCADE`: leaving the models behind would orphan
 * rows that no screen can reach, since the model list is always read through its supplier.
 */
export async function deleteSupplier(id: number): Promise<void> {
  await suppliersCol().deleteOne({ _id: id });
  await modelsCol().deleteMany({ supplier_id: id });
}

export async function listModels(): Promise<AiModelDoc[]> {
  return modelsCol().find({}).sort({ _id: 1 }).toArray();
}

export async function listModelsForSupplier(supplierId: number): Promise<AiModelDoc[]> {
  return modelsCol().find({ supplier_id: supplierId }).sort({ _id: 1 }).toArray();
}

export async function getModel(id: number): Promise<AiModelDoc | null> {
  return modelsCol().findOne({ _id: id });
}

export async function createModel(input: {
  supplier_id: number;
  model_id: string;
  label?: string | null;
}): Promise<number> {
  const id = await nextId(getDb(), "ai_models");
  await modelsCol().insertOne({
    _id: id,
    supplier_id: input.supplier_id,
    model_id: input.model_id,
    label: input.label ?? null,
  } as AiModelDoc);
  return id;
}

export async function deleteModel(id: number): Promise<void> {
  await modelsCol().deleteOne({ _id: id });
}

export async function deleteModels(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const result = await modelsCol().deleteMany({ _id: { $in: ids } });
  return result.deletedCount ?? 0;
}

/**
 * One supplier together with its models, which is how every caller wants to read them.
 * SQLite needed two queries per supplier or a join; the embedded shape is what Mongo gives.
 */
export type SupplierWithModels = AiSupplierDoc & { models: AiModelDoc[] };

export async function loadSuppliersWithModels(): Promise<SupplierWithModels[]> {
  const suppliers = await listSuppliers();
  const models = await listModels();
  const bySupplier = new Map<number, AiModelDoc[]>();
  for (const m of models) {
    const list = bySupplier.get(m.supplier_id) ?? [];
    list.push(m);
    bySupplier.set(m.supplier_id, list);
  }
  return suppliers.map((s) => ({
    ...s,
    models: bySupplier.get(s._id) ?? [],
  }));
}
