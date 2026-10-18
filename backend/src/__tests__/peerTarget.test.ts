import { describe, it, expect, vi } from 'vitest';
import { Api } from 'telegram';
import { parsePeerTarget, displayPeerId, resolvePeerTarget } from '../tg/peerTarget';

describe('parsePeerTarget', () => {
  it('reads the ID forms Telegram clients and bots show', () => {
    expect(parsePeerTarget('-1001234567890')).toEqual({ kind: 'id', id: '1234567890', peerType: 'channel' });
    expect(parsePeerTarget('-1234567890')).toEqual({ kind: 'id', id: '1234567890', peerType: 'chat' });
    expect(parsePeerTarget(' 611754575 ')).toEqual({ kind: 'id', id: '611754575' });
  });

  it('reads the ID forms the messenger copies', () => {
    expect(parsePeerTarget('c1234567890')).toEqual({ kind: 'id', id: '1234567890', peerType: 'channel' });
    expect(parsePeerTarget('g42')).toEqual({ kind: 'id', id: '42', peerType: 'chat' });
    expect(parsePeerTarget('u7')).toEqual({ kind: 'id', id: '7', peerType: 'user' });
  });

  it('still reads usernames and invite links', () => {
    expect(parsePeerTarget('@somegroup')).toEqual({ kind: 'username', username: 'somegroup' });
    expect(parsePeerTarget('https://t.me/somegroup')).toEqual({ kind: 'username', username: 'somegroup' });
    expect(parsePeerTarget('https://t.me/+AbC-123_x')).toEqual({ kind: 'invite', hash: 'AbC-123_x' });
    expect(parsePeerTarget('t.me/joinchat/AbC123')).toEqual({ kind: 'invite', hash: 'AbC123' });
  });

  it('rejects what names no chat', () => {
    expect(parsePeerTarget('')).toBeNull();
    expect(parsePeerTarget('  ')).toBeNull();
    expect(parsePeerTarget('9lives')).toBeNull();
  });
});

describe('displayPeerId', () => {
  it('turns the messenger ID into the form a job field takes', () => {
    expect(displayPeerId('c2352332')).toBe('-1002352332');
    expect(displayPeerId('g2352332')).toBe('-2352332');
    expect(displayPeerId('u6117545750')).toBe('6117545750');
  });
});

describe('resolvePeerTarget', () => {
  const group = Object.assign(new Api.Channel({} as any), { id: BigInt(1234567890) });

  function fakeClient(overrides: Record<string, any> = {}) {
    return {
      getEntity: vi.fn().mockRejectedValue(new Error('Could not find the input entity')),
      iterDialogs: vi.fn(async function* () {
        yield { entity: Object.assign(new Api.Channel({} as any), { id: BigInt(999) }) };
        yield { entity: group };
      }),
      ...overrides,
    } as any;
  }

  it('finds a private group in the chat list when the ID alone resolves nowhere', async () => {
    const client = fakeClient();
    await expect(resolvePeerTarget(client, '-1001234567890')).resolves.toBe(group);
    expect(client.iterDialogs).toHaveBeenCalled();
  });

  it('takes what Telegram resolves without walking the chat list', async () => {
    const client = fakeClient({ getEntity: vi.fn().mockResolvedValue(group) });
    await expect(resolvePeerTarget(client, 'c1234567890')).resolves.toBe(group);
    expect(client.iterDialogs).not.toHaveBeenCalled();
  });

  it('says so when the account is not in the group', async () => {
    await expect(resolvePeerTarget(fakeClient(), '-1009999999999')).rejects.toThrow(
      /must be a member/,
    );
  });

  it('passes a username straight through', async () => {
    const client = fakeClient({ getEntity: vi.fn().mockResolvedValue(group) });
    await expect(resolvePeerTarget(client, '@somegroup')).resolves.toBe(group);
    expect(client.getEntity).toHaveBeenCalledWith('somegroup');
  });
});
