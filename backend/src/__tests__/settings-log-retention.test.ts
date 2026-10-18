// Tests for the log_retention_days setting: whitelist membership and the
// immediate purge triggered when the value is saved.

const { mockPurge, mockRefresh } = vi.hoisted(() => ({
  mockPurge: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('../scheduler', () => ({
  refreshScheduler: mockRefresh,
  purgeOldLogs: mockPurge,
}));
vi.mock('../jobs/runner', () => ({ parseTgProxy: vi.fn() }));
vi.mock('socks', () => ({ SocksClient: { createConnection: vi.fn() } }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import settingsRouter, { ALLOWED_KEYS } from '../routes/settings';
import { getSetting, setSetting } from '../db/repos/settings';
import { useTestDb } from './helpers/db';

// The panel writes to the settings collection, so the value is read back from there rather
// than asserted off a mocked `run`.
useTestDb();

/** Pulls a route handler out of the Express router so it can be called directly. */
function routeHandler(method: string, path: string) {
  const layer = (settingsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle as (req: any, res: any) => any;
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

const putSettings = routeHandler('put', '/');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('log_retention_days setting', () => {
  it('is an allowed settings key', () => {
    expect(ALLOWED_KEYS).toContain('log_retention_days');
  });

  it('persists the value and purges immediately when saved', async () => {
    await putSettings({ body: { log_retention_days: '30' } }, makeRes());

    expect(await getSetting('log_retention_days')).toBe('30');
    expect(mockPurge).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does not purge when the retention setting is untouched', async () => {
    await putSettings({ body: { default_timezone: 'UTC' } }, makeRes());

    expect(await getSetting('default_timezone')).toBe('UTC');
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('is returned to the client by GET /settings', async () => {
    await setSetting('log_retention_days', '7');
    const res = makeRes();

    await routeHandler('get', '/')({}, res);

    expect(res.body.log_retention_days).toBe('7');
  });
});
