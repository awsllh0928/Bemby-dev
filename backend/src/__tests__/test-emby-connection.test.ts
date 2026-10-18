// Unit tests for testEmbyConnection: the pre-save connectivity/credential
// check used by the jobs and templates screens.

const { mockUndiciFetch, MockProxyAgent, MockAgent } = vi.hoisted(() => ({
  mockUndiciFetch: vi.fn(),
  MockProxyAgent: vi.fn(),
  MockAgent: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: mockUndiciFetch,
  ProxyAgent: MockProxyAgent,
  Agent: MockAgent,
}));

vi.mock('node:dns', () => ({ lookup: vi.fn() }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testEmbyConnection } from '../jobs/embywatch';
import { setSetting } from '../db/repos/settings';
import { useTestDb } from './helpers/db';

// The proxy pool is a setting, so this uses a real database: each test starts with nothing
// stored, which is what "all defaults" meant when the settings table was stubbed out.
useTestDb();

const creds = { username: 'user', password: 'pass' };

function mockAuthSuccess() {
  mockUndiciFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }),
      ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('testEmbyConnection', () => {
  it('returns ok with the user name when authentication succeeds', async () => {
    mockAuthSuccess();

    const result = await testEmbyConnection('https://emby.example.com', creds);

    expect(result).toEqual({ ok: true, userName: 'Tester' });
  });

  it('sends the credentials to /Users/AuthenticateByName', async () => {
    mockAuthSuccess();

    await testEmbyConnection('https://emby.example.com', creds);

    const [url, opts] = mockUndiciFetch.mock.calls[0] as [string, any];
    expect(url).toBe('https://emby.example.com/Users/AuthenticateByName');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ Username: 'user', Pw: 'pass' });
    expect(opts.headers['X-Emby-Authorization']).toContain('MediaBrowser');
  });

  it('returns ok false with the server message on invalid credentials', async () => {
    mockUndiciFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve(JSON.stringify({ Message: 'Invalid user or password' })),
    });

    const result = await testEmbyConnection('https://emby.example.com', creds);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).toContain('Invalid user or password');
  });

  it('returns ok false when the server is unreachable', async () => {
    mockUndiciFetch.mockRejectedValue(
      Object.assign(new Error('net'), { cause: { code: 'ECONNREFUSED' } }),
    );

    const result = await testEmbyConnection('https://emby.example.com', creds);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Cannot reach Emby server');
  });

  it('passes an abort signal so a dead host cannot hang the request', async () => {
    mockAuthSuccess();

    await testEmbyConnection('https://emby.example.com', creds);

    const opts = mockUndiciFetch.mock.calls[0][1] as any;
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the given user agent, falling back to the default when absent', async () => {
    mockAuthSuccess();
    await testEmbyConnection('https://emby.example.com', { ...creds, userAgent: 'MyPlayer/1.0' });
    expect((mockUndiciFetch.mock.calls[0][1] as any).headers['User-Agent']).toBe('MyPlayer/1.0');

    mockUndiciFetch.mockClear();
    mockAuthSuccess();
    await testEmbyConnection('https://emby.example.com', creds);
    expect((mockUndiciFetch.mock.calls[0][1] as any).headers['User-Agent']).toContain('SenPlayer');
  });

  it('derives the auth header Client and Version from the user agent', async () => {
    mockAuthSuccess();
    await testEmbyConnection('https://emby.example.com', { ...creds, userAgent: 'CapyPlayer/1.2.3 CFNetwork/1.0' });
    const auth = (mockUndiciFetch.mock.calls[0][1] as any).headers['X-Emby-Authorization'];
    expect(auth).toContain('Client="CapyPlayer"');
    expect(auth).toContain('Version="1.2.3"');
    expect(auth).not.toContain('SenPlayer');
  });

  it('routes through the configured proxy when proxyId is given', async () => {
    await setSetting(
      'proxies',
      JSON.stringify([{ id: 'p1', name: 'P', url: 'http://proxy.local:3128' }]),
    );
    mockAuthSuccess();

    const result = await testEmbyConnection('https://emby.example.com', {
      ...creds,
      proxyId: 'p1',
    });

    expect(result.ok).toBe(true);
    expect(MockProxyAgent).toHaveBeenCalledWith('http://proxy.local:3128');
    expect((mockUndiciFetch.mock.calls[0][1] as any).dispatcher).toBeInstanceOf(MockProxyAgent);
  });

  it('uses the direct IPv4 agent when no proxy is configured', async () => {
    mockAuthSuccess();

    await testEmbyConnection('https://emby.example.com', creds);

    expect(MockProxyAgent).not.toHaveBeenCalled();
    expect((mockUndiciFetch.mock.calls[0][1] as any).dispatcher).toBeInstanceOf(MockAgent);
  });
});
