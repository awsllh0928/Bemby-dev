// Tests that requestCode correctly forwards proxy config to TelegramClient.
// vi.hoisted ensures mock values are available inside the vi.mock() factory
// (which is hoisted to the top of the file before const declarations run).

const { mockConnect, mockSendCode, mockDestroy, MockTelegramClient } = vi.hoisted(() => {
  const mockConnect    = vi.fn().mockResolvedValue(undefined);
  const mockSendCode   = vi.fn().mockResolvedValue({ phoneCodeHash: 'hash123' });
  const mockDestroy    = vi.fn().mockResolvedValue(undefined);
  const MockTelegramClient = vi.fn().mockReturnValue({
    connect: mockConnect,
    sendCode: mockSendCode,
    destroy: mockDestroy,
    session: { save: vi.fn().mockReturnValue('') },
  });
  return { mockConnect, mockSendCode, mockDestroy, MockTelegramClient };
});

vi.mock('telegram', () => ({
  TelegramClient: MockTelegramClient,
  Api: {},
  Logger: vi.fn().mockReturnValue({}),
}));

vi.mock('telegram/sessions', () => ({
  StringSession: vi.fn().mockReturnValue({}),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramClient } from 'telegram';
import { requestCode, sweepPendingAuth } from '../auth/tgAuth';
import type { TgProxy } from '../types';

beforeEach(() => vi.clearAllMocks());

// Each test uses a unique account ID to avoid state leakage from the module-level
// pending Map (vi.clearAllMocks does not reset module variables between tests).

describe('requestCode', () => {
  it('does not set proxy option when proxy is undefined', async () => {
    await requestCode(101, 12345, 'apihash', '+61400000001');

    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('proxy');
  });

  it('passes proxy option to TelegramClient when TgProxy is provided', async () => {
    const proxy: TgProxy = { ip: '10.0.0.1', port: 1080, socksType: 5 };
    await requestCode(102, 12345, 'apihash', '+61400000001', proxy);

    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts).toHaveProperty('proxy', proxy);
  });

  it('sets socksType correctly for SOCKS4', async () => {
    const proxy: TgProxy = { ip: '10.0.0.2', port: 1081, socksType: 4 };
    await requestCode(103, 12345, 'apihash', '+61400000001', proxy);

    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect((opts.proxy as TgProxy).socksType).toBe(4);
  });

  it('destroys an existing pending session before reconnecting for the same account', async () => {
    await requestCode(104, 12345, 'apihash', '+61400000001');
    vi.clearAllMocks();
    await requestCode(104, 12345, 'apihash', '+61400000001');

    // Second call must destroy the prior session and create a fresh client
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(MockTelegramClient).toHaveBeenCalledTimes(1);
  });

  it('applies the new proxy when reconnecting with a different proxy', async () => {
    await requestCode(105, 12345, 'apihash', '+61400000001');
    vi.clearAllMocks();

    const proxy: TgProxy = { ip: '10.0.0.3', port: 1080, socksType: 5 };
    await requestCode(105, 12345, 'apihash', '+61400000001', proxy);

    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts).toHaveProperty('proxy', proxy);
  });
});

// ---- abandoned session sweep -----------------------------------------------

// A pending entry holds a connected TelegramClient. An auth nobody finishes (tab
// closed at the code prompt, bulk add moved on) would otherwise pin that
// connection for the life of the process.
describe('sweepPendingAuth', () => {
  const TTL_MS = 15 * 60_000;

  // pending is module-level, so the sessions the tests above abandoned are still in
  // it. Clear them first so these assertions count only their own entry.
  beforeEach(() => {
    sweepPendingAuth(Date.now() + TTL_MS * 1000);
    mockDestroy.mockClear();
  });

  it('leaves a session that is still within its TTL', async () => {
    await requestCode(201, 12345, 'apihash', '+61400000001');

    expect(sweepPendingAuth(Date.now() + TTL_MS - 1_000)).toBe(0);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('destroys and drops a session left past its TTL', async () => {
    await requestCode(202, 12345, 'apihash', '+61400000001');

    expect(sweepPendingAuth(Date.now() + TTL_MS + 1)).toBe(1);
    expect(mockDestroy).toHaveBeenCalledTimes(1);

    // Already gone, so a second sweep has nothing to do
    expect(sweepPendingAuth(Date.now() + TTL_MS * 10)).toBe(0);
  });
});
