import { Router } from 'express';
import {
  buildLogMatch,
  countLogsJoined,
  getLog,
  listLogsJoined,
  logSort,
  setRetired,
  updateLog,
  type LogRow,
} from '../db/repos/logs';
import { cancelJob, isJobRunning, getLiveDetail } from '../jobs/cancellation';
import { parsePaging, textParam } from './list-query';

const router = Router();

/** Parses a positive integer query param, clamped to [1, max]. */
function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

// The joined log row -> wire shape used by both list endpoints and the detail view.
const toJson = (r: LogRow) => ({
  id: r._id,
  jobId: r.job_id,
  jobName: r.job_name,
  jobType: r.job_type ?? null,
  accountName: r.account_name,
  ranAt: r.ran_at,
  status: r.status,
  message: r.message,
  retired: r.retired === 1,
});

router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    // Same three-hop join as the list (job_logs -> jobs -> tg_accounts), narrowed to one row.
    const rows = await listLogsJoined({ _id: id }, undefined, undefined, 1);
    const row = rows[0];
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    const liveDetail = getLiveDetail(id);
    res.json({
      id: row._id,
      jobId: row.job_id,
      jobName: row.job_name,
      jobType: row.job_type ?? null,
      accountName: row.account_name,
      ranAt: row.ran_at,
      status: row.status,
      message: row.message,
      detail: liveDetail ?? (row.detail ? JSON.parse(row.detail) : null),
    });
  } catch (e) {
    console.error('[logs] get log failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { jobId, limit, offset, showRetired = '0' } = req.query as Record<string, string>;
    const query = req.query as Record<string, unknown>;
    const paging = parsePaging(query);
    const search = textParam(query.search);
    const status = textParam(query.status);

    let parsedJobId: number | undefined;
    if (jobId) {
      const parsed = Number(jobId);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        res.status(400).json({ error: 'Invalid jobId' });
        return;
      }
      parsedJobId = parsed;
    }

    const match = await buildLogMatch({
      jobId: parsedJobId,
      status,
      retired: showRetired === '1',
      search,
    });
    const sort = logSort(undefined, undefined);

    if (!paging) {
      // Legacy limit/offset shape
      const parsedLimit = parsePositiveInt(limit, 50, 200);
      const parsedOffset = parseNonNegativeInt(offset, 0);
      const rows = await listLogsJoined(match, sort, parsedOffset, parsedLimit);
      res.json(rows.map(toJson));
      return;
    }

    const total = await countLogsJoined(match);
    // "All" arrives as pageSize<=0, which list-query turns into limit -1: no $limit stage then.
    const rows = await listLogsJoined(
      match,
      sort,
      paging.offset,
      paging.limit > 0 ? paging.limit : undefined,
    );

    res.json({
      items: rows.map(toJson),
      total,
      page: paging.page,
      pageSize: paging.pageSize,
    });
  } catch (e) {
    console.error('[logs] list logs failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/retire', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await getLog(id);
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    const newVal = row.retired ? 0 : 1;
    await setRetired(id, newVal === 1);
    res.json({ retired: newVal === 1 });
  } catch (e) {
    console.error('[logs] retire log failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const logId = Number(req.params.id);
    if (isJobRunning(logId)) {
      cancelJob(logId);
      res.json({ message: 'Cancel signal sent' });
      return;
    }
    // No live process: the row is likely orphaned after a restart. Force-mark a
    // stuck 'running' row as failed so it can be cleared from the UI. (issue #18)
    const row = await getLog(logId);
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    if (row.status !== 'running') {
      res.status(404).json({ error: 'No running job found for this log entry' });
      return;
    }
    await updateLog(logId, { status: 'failed', message: 'Force stopped' });
    res.json({ message: 'Force stopped' });
  } catch (e) {
    console.error('[logs] cancel log failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
