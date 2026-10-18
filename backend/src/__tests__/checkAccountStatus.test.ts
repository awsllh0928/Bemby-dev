// Tests for checkAccountStatus in tgAuth.ts.
// Uses the same vi.hoisted + vi.mock pattern as tgAuth.test.ts so the
// MockTelegramClient reference is shared between the factory and assertions.

const { mockGetMe, mockConnect, mockDestroy, MockTelegramClient } = vi.hoisted(() => {
  const mockGetMe    = vi.fn();
  const mockConnect  = vi.fn().mockResolvedValue(undefined);
  const mockDestroy = vi.fn().mockResolvedValue(undefined);
  const MockTelegramClient = vi.fn().mockReturnValue({
    connect:    mockConnect,
    getMe:      mockGetMe,
    destroy: mockDestroy,
    session:    { save: vi.fn().mockReturnValue('') },
  });
  return { mockGetMe, mockConnect, mockDestroy, MockTelegramClient };
});

vi.mock('telegram', () => ({
  TelegramClient: MockTelegramClient,
  Api: {},
  Logger: vi.fn().mockReturnValue({}),
}));

vi.mock('telegram/extensions/Logger', () => ({ LogLevel: { NONE: 0 } }));
vi.mock('telegram/sessions', () => ({ StringSession: vi.fn().mockReturnValue({}) }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramClient } from 'telegram';
import { checkAccountStatus } from '../auth/tgAuth';
import type { TgProxy } from '../types';

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Active account
// ---------------------------------------------------------------------------

describe('checkAccountStatus — active account', () => {
  beforeEach(() => {
    mockGetMe.mockResolvedValue({
      firstName: 'Alice',
      lastName:  'Smith',
      username:  'alicesmith',
      phone:     '61412345678',
      deleted:   false,
      restricted: false,
      restrictionReason: [],
    });
  });

  it('returns isActive true', async () => {
    const s = await checkAccountStatus(1, 'hash', 'sess');
    expect(s.isActive).toBe(true);
  });

  it('returns isDeleted false', async () => {
    const s = await checkAccountStatus(1, 'hash', 'sess');
    expect(s.isDeleted).toBe(false);
  });

  it('returns isRestricted false', async () => {
    const s = await checkAccountStatus(1, 'hash', 'sess');
    expect(s.isRestricted).toBe(false);
  });

  it('maps profile fields correctly', async () => {
    const s = await checkAccountStatus(1, 'hash', 'sess');
    expect(s.firstName).toBe('Alice');
    expect(s.lastName).toBe('Smith');
    expect(s.username).toBe('alicesmith');
    expect(s.phone).toBe('61412345678');
  });

  it('returns an empty restrictions array', async () => {
    const s = await checkAccountStatus(1, 'hash', 'sess');
    expect(s.restrictions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Deleted / deactivated account
// ---------------------------------------------------------------------------

describe('checkAccountStatus — deleted account', () => {
  it('returns isDeleted true when deleted flag is set', async () => {
    mockGetMe.mockResolvedValue({
      firstName: '', deleted: true, restricted: false, restrictionReason: [],
    });
    const s = await checkAccountStatus(1, 'hash', 'sess');
    expect(s.isDeleted).toBe(true);
    expect(s.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Restricted account
// ---------------------------------------------------------------------------

describe('checkAccountStatus — restricted account', () => {
  it('returns isRestricted true with restriction details', async () => {
    mockGetMe.mockResolvedValue({
      firstName: 'Bob',
      deleted:   false,
      restricted: true,
      restrictionReason: [
        { platform: 'all', reason: 'spam', text: 'Account restricted for spam activity' },
      ],
    });
    const s = await checkAccountStatus(1, 'hash', 'sess');
    expect(s.isRestricted).toBe(true);
    expect(s.restrictions).toHaveLength(1);
    expect(s.restrictions[0]).toEqual({
      platform: 'all',
      reason:   'spam',
      text:     'Account restricted for spam activity',
    });
  });

  it('maps multiple restriction reasons', async () => {
    mockGetMe.mockResolvedValue({
      firstName: 'Carol',
      deleted:   false,
      restricted: true,
      restrictionReason: [
        { platform: 'ios',     reason: 'spam', text: 'Spam (iOS)' },
        { platform: 'android', reason: 'spam', text: 'Spam (Android)' },
      ],
    });
    const s = await checkAccountStatus(1, 'hash', 'sess');
    expect(s.restrictions).toHaveLength(2);
    expect(s.restrictions.map(r => r.platform)).toEqual(['ios', 'android']);
  });

  it('handles undefined restrictionReason gracefully', async () => {
    mockGetMe.mockResolvedValue({
      firstName: 'Dave', deleted: false, restricted: false, restrictionReason: undefined,
    });
    const s = await checkAccountStatus(1, 'hash', 'sess');
    expect(s.restrictions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Proxy forwarding
// ---------------------------------------------------------------------------

describe('checkAccountStatus — proxy', () => {
  beforeEach(() => {
    mockGetMe.mockResolvedValue({
      firstName: 'Eve', deleted: false, restricted: false, restrictionReason: [],
    });
  });

  it('does not set proxy option when none provided', async () => {
    await checkAccountStatus(1, 'hash', 'sess');
    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('proxy');
  });

  it('passes proxy to TelegramClient when provided', async () => {
    const proxy: TgProxy = { ip: '10.0.0.1', port: 1080, socksType: 5 };
    await checkAccountStatus(1, 'hash', 'sess', proxy);
    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts).toHaveProperty('proxy', proxy);
  });

  it('passes SOCKS4 proxy type correctly', async () => {
    const proxy: TgProxy = { ip: '10.0.0.2', port: 1081, socksType: 4 };
    await checkAccountStatus(1, 'hash', 'sess', proxy);
    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect((opts.proxy as TgProxy).socksType).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Disconnect behaviour
// ---------------------------------------------------------------------------

describe('checkAccountStatus — destroy', () => {
  it('destroys the client after a successful check', async () => {
    mockGetMe.mockResolvedValue({
      firstName: 'Frank', deleted: false, restricted: false, restrictionReason: [],
    });
    await checkAccountStatus(1, 'hash', 'sess');
    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  it('destroys the client even when getMe throws', async () => {
    mockGetMe.mockRejectedValue(new Error('SESSION_REVOKED'));
    await expect(checkAccountStatus(1, 'hash', 'sess')).rejects.toThrow('SESSION_REVOKED');
    expect(mockDestroy).toHaveBeenCalledOnce();
  });
});
