import { describe, expect, it } from 'vitest';
import { backendOrigin, localCookie, localProxyRequest } from '../../scripts/dev-proxy';

describe('local API proxy', () => {
  it('requires a fixed HTTPS backend origin without credentials or a path', () => {
    expect(backendOrigin('https://voice.example/')).toBe('https://voice.example');
    for (const target of [
      undefined,
      'http://voice.example',
      'https://user:secret@voice.example',
      'https://voice.example/path',
      'https://voice.example/?token=secret',
    ])
      expect(() => backendOrigin(target)).toThrow('VOICE_BACKEND_URL');
  });
  it('only forwards same-origin loopback mutations', () => {
    const headers = { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' };
    expect(localProxyRequest('POST', headers)).toBe(true);
    expect(localProxyRequest('GET', { host: headers.host })).toBe(true);
    expect(localProxyRequest('POST', { host: headers.host })).toBe(false);
    expect(localProxyRequest('POST', { ...headers, origin: 'https://attacker.example' })).toBe(
      false,
    );
    expect(localProxyRequest('POST', { ...headers, 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(
      localProxyRequest('POST', { host: 'attacker.example', origin: 'http://attacker.example' }),
    ).toBe(false);
  });
  it('preserves session protection when adapting cookies for local HTTP', () => {
    const cookie = localCookie(
      'voice_session=signed; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=3600',
    );
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');
  });
});
