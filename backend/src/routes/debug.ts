import express from 'express';
import { callAI } from '../jobs/checkin';

const router = express.Router();

router.post('/ai', async (req: express.Request, res: express.Response) => {
  const { images = [], prompt, maxTokens = 5000, model } = req.body as {
    images?: string[];
    prompt?: string;
    maxTokens?: number;
    model?: string;
  };

  if (!prompt?.trim()) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  const t0 = Date.now();
  try {
    const { response } = await callAI(images, prompt.trim(), maxTokens, model);
    res.json({ response, durationMs: Date.now() - t0 });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

export default router;
