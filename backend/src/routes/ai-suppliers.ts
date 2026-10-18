import { Router } from 'express';
import { deleteSetting, getSetting } from '../db/repos/settings';
import {
  createModel,
  createSupplier,
  deleteModel,
  deleteSupplier,
  getModel,
  getSupplier,
  loadSuppliersWithModels,
  updateSupplier,
} from '../db/repos/ai';
import type { AiModelDoc, AiSupplierDoc } from '../db/types';

const router = Router();

type SupplierRow = { id: number; name: string; base_url: string; api_key: string; timeout_ms: number };
type ModelRow    = { id: number; supplier_id: number; model_id: string; label: string | null };

// The documents carry their id as `_id`; the JSON these routes have always sent uses `id`.
function toSupplierRow(s: AiSupplierDoc): SupplierRow {
  return { id: s._id, name: s.name, base_url: s.base_url, api_key: s.api_key, timeout_ms: s.timeout_ms };
}

function toModelRow(m: AiModelDoc): ModelRow {
  return { id: m._id, supplier_id: m.supplier_id, model_id: m.model_id, label: m.label ?? null };
}

/** Removes the pinned-default setting when its ai_models row no longer exists. */
async function clearDanglingDefaultModel() {
  const pinned = await getSetting('ai_default_model_id');
  if (!pinned) return;
  if (!(await getModel(Number(pinned)))) {
    await deleteSetting('ai_default_model_id');
  }
}

const maskKey = (key: string) => {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
};

async function listAll() {
  const suppliers = await loadSuppliersWithModels();
  return suppliers.map(s => ({
    ...toSupplierRow(s),
    api_key: maskKey(s.api_key),
    models: s.models.map(toModelRow),
  }));
}

router.get('/', async (_req, res) => {
  try {
    res.json(await listAll());
  } catch (err) {
    console.error('[ai-suppliers] list:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  const { name, base_url, api_key = '', timeout_ms = 25000 } = req.body as Partial<SupplierRow>;
  if (!name?.trim() || !base_url?.trim()) {
    res.status(400).json({ error: 'name and base_url are required' });
    return;
  }
  try {
    const id = await createSupplier({
      name: name.trim(),
      base_url: base_url.trim(),
      api_key: (api_key ?? '').trim(),
      timeout_ms: Number(timeout_ms),
    });
    const created = await getSupplier(id);
    res.json({ ...toSupplierRow(created as AiSupplierDoc), api_key: maskKey((created as AiSupplierDoc).api_key) });
  } catch (err) {
    console.error('[ai-suppliers] create:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const existing = await getSupplier(id);
    if (!existing) { res.status(404).json({ error: 'Supplier not found' }); return; }

    const { name, base_url, api_key, timeout_ms } = req.body as Partial<SupplierRow>;
    await updateSupplier(id, {
      name: name?.trim() ?? existing.name,
      base_url: base_url?.trim() ?? existing.base_url,
      api_key: api_key !== undefined && !api_key.includes('*') ? api_key.trim() : existing.api_key,
      timeout_ms: timeout_ms !== undefined ? Number(timeout_ms) : existing.timeout_ms,
    });
    const updated = await getSupplier(id);
    res.json({ ...toSupplierRow(updated as AiSupplierDoc), api_key: maskKey((updated as AiSupplierDoc).api_key) });
  } catch (err) {
    console.error('[ai-suppliers] update:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteSupplier(Number(req.params.id));
    await clearDanglingDefaultModel();
    res.json({ ok: true });
  } catch (err) {
    console.error('[ai-suppliers] delete:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/models', async (req, res) => {
  const supplierId = Number(req.params.id);
  const { model_id, label } = req.body as { model_id?: string; label?: string };
  if (!model_id?.trim()) { res.status(400).json({ error: 'model_id is required' }); return; }
  try {
    if (!(await getSupplier(supplierId))) {
      res.status(404).json({ error: 'Supplier not found' }); return;
    }
    const id = await createModel({
      supplier_id: supplierId,
      model_id: model_id.trim(),
      label: label?.trim() || null,
    });
    const created = await getModel(id);
    res.json(toModelRow(created as AiModelDoc));
  } catch (err) {
    console.error('[ai-suppliers] create model:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/models/:modelId', async (req, res) => {
  try {
    await deleteModel(Number(req.params.modelId));
    await clearDanglingDefaultModel();
    res.json({ ok: true });
  } catch (err) {
    console.error('[ai-suppliers] delete model:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
