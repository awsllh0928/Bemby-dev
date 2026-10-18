import { Router } from 'express';
import { getSchedulerStatus, skipNextRun } from '../scheduler';
import { memoryReport } from '../monitor/memory';

const router = Router();

router.get('/', (req, res) => {
  res.json(getSchedulerStatus());
});

// POST /skip/:jobId -- give up the pending run and arm the one after it. The job keeps its
// schedule; this is calling off one occurrence, not disabling anything.
router.post('/skip/:jobId', async (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    res.status(400).json({ error: 'Invalid job id' });
    return;
  }
  try {
    const result = await skipNextRun(jobId);
    if (!result.ok) {
      res.status(404).json({ error: 'That job has no scheduled run' });
      return;
    }
    res.json(result);
  } catch (e) {
    console.error('[status] skip failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Separate path so the schedule list above keeps returning a bare array
router.get('/memory', async (req, res) => {
  try {
    res.json(await memoryReport());
  } catch (e) {
    console.error('[status] memory report failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
