// Tests for POST /jobs/test-emby: input validation and passthrough to
// testEmbyConnection.

vi.mock('../db/database', () => ({ db: { prepare: vi.fn() } }));
vi.mock('../jobs/runner', () => ({ runJob: vi.fn() }));
vi.mock('../jobs/notify', () => ({
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildFailureMessage: vi.fn(),
  buildSuccessMessage: vi.fn(),
  getNotifyConfig: vi.fn(),
}));
vi.mock('../scheduler', () => ({ refreshScheduler: vi.fn() }));
vi.mock('../jobs/cancellation', () => ({
  registerJob: vi.fn(),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock('../jobs/embywatch', () => ({ testEmbyConnection: vi.fn() }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jobsRouter from '../routes/jobs';
import { testEmbyConnection } from '../jobs/embywatch';

/** Pulls a route handler out of the Express router so it can be called directly. */
function routeHandler(method: string, path: string) {
  const layer = (jobsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle as (req: any, res: any) => Promise<void>;
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

const handler = routeHandler('post', '/test-emby');
const validBody = {
  serverUrl: 'https://emby.example.com',
  username: 'user',
  password: 'pass',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /jobs/test-emby', () => {
  it.each([
    ['serverUrl', { ...validBody, serverUrl: undefined }],
    ['username', { ...validBody, username: undefined }],
    ['password', { ...validBody, password: undefined }],
  ])('rejects a request missing %s', async (_field, body) => {
    const res = makeRes();
    await handler({ body }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('required');
    expect(testEmbyConnection).not.toHaveBeenCalled();
  });

  it('rejects a serverUrl without an http(s) protocol', async () => {
    const res = makeRes();
    await handler({ body: { ...validBody, serverUrl: 'emby.example.com' } }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('http');
    expect(testEmbyConnection).not.toHaveBeenCalled();
  });

  it('returns the verification result on success', async () => {
    vi.mocked(testEmbyConnection).mockResolvedValue({ ok: true, userName: 'Tester' });
    const res = makeRes();

    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, userName: 'Tester' });
    expect(testEmbyConnection).toHaveBeenCalledWith('https://emby.example.com', {
      username: 'user',
      password: 'pass',
      userAgent: undefined,
      proxyId: undefined,
    });
  });

  it('passes userAgent and proxyId through to the verification', async () => {
    vi.mocked(testEmbyConnection).mockResolvedValue({ ok: true });
    const res = makeRes();

    await handler(
      { body: { ...validBody, userAgent: 'MyPlayer/1.0', proxyId: 'p1' } },
      res,
    );

    expect(testEmbyConnection).toHaveBeenCalledWith('https://emby.example.com', {
      username: 'user',
      password: 'pass',
      userAgent: 'MyPlayer/1.0',
      proxyId: 'p1',
    });
  });

  it('returns ok false with the failure reason when verification fails', async () => {
    vi.mocked(testEmbyConnection).mockResolvedValue({
      ok: false,
      error: 'Cannot reach Emby server',
    });
    const res = makeRes();

    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: false, error: 'Cannot reach Emby server' });
  });
});
