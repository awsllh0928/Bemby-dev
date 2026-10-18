import { describe, it, expect } from 'vitest';
import { parseProxyLine } from '../tg/proxyProviders';

describe('parseProxyLine', () => {
  it('reads the ip:port:user:pass form sellers download links use', () => {
    expect(parseProxyLine('84.247.60.125:6095:fvjotyaf:37693q8e3nno')).toBe(
      'http://fvjotyaf:37693q8e3nno@84.247.60.125:6095',
    );
  });

  it('reads user:pass@host:port', () => {
    expect(parseProxyLine('user:secret@proxy.example.com:1080')).toBe(
      'http://user:secret@proxy.example.com:1080',
    );
  });

  it('reads a bare ip:port', () => {
    expect(parseProxyLine('1.2.3.4:8080')).toBe('http://1.2.3.4:8080');
  });

  it('keeps an explicit scheme and honours the fallback otherwise', () => {
    expect(parseProxyLine('socks5://user:pw@1.2.3.4:1080')).toBe('socks5://user:pw@1.2.3.4:1080');
    expect(parseProxyLine('1.2.3.4:1080:user:pw', 'socks5')).toBe('socks5://user:pw@1.2.3.4:1080');
  });

  it('percent-encodes credentials so odd characters survive the URL', () => {
    expect(parseProxyLine('1.2.3.4:8080:user@name:p@ss:word')).toBeUndefined();
    expect(parseProxyLine('us%r:p a@1.2.3.4:8080')).toBe('http://us%25r:p%20a@1.2.3.4:8080');
  });

  it('ignores blanks, comments and malformed lines', () => {
    expect(parseProxyLine('')).toBeUndefined();
    expect(parseProxyLine('   ')).toBeUndefined();
    expect(parseProxyLine('# a comment')).toBeUndefined();
    expect(parseProxyLine('// another')).toBeUndefined();
    expect(parseProxyLine('not-a-proxy')).toBeUndefined();
    expect(parseProxyLine('1.2.3.4:notaport')).toBeUndefined();
    expect(parseProxyLine('1.2.3.4:8080:onlyuser')).toBeUndefined();
  });
});
