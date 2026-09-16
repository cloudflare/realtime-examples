import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { demand } from './rpc.ts';
import { equal } from './crypto.ts';
import type { HttpApp } from './http.ts';

async function signature(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('Origin');
  demand(!origin || origin === new URL(request.url).origin, 403, 'Origin not allowed.');
  demand(
    request.headers.get('Sec-Fetch-Site') !== 'cross-site',
    403,
    'Cross-site request rejected.',
  );
}
export async function authenticated(c: Context<HttpApp>): Promise<boolean> {
  const request = c.req.raw,
    env = c.env;
  const url = new URL(request.url);
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
  const cookie = getCookie(c, 'radio_auth');
  if (!cookie) return false;
  const [expires, nonce, mac] = cookie.split('.');
  if (
    !expires ||
    !nonce ||
    !mac ||
    !Number.isFinite(Number(expires)) ||
    Number(expires) < Date.now()
  )
    return false;
  return equal(mac, await signature(`${expires}.${nonce}`, env.VIEWER_PASSWORD));
}
export async function login(password: string, c: Context<HttpApp>): Promise<Response> {
  const request = c.req.raw,
    env = c.env;
  demand(await equal(password, env.VIEWER_PASSWORD), 401, 'That password did not match.');
  const value = `${Date.now() + 86400000}.${crypto.randomUUID()}`;
  const cookie = `${value}.${await signature(value, env.VIEWER_PASSWORD)}`;
  setCookie(c, 'radio_auth', cookie, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/api',
    maxAge: 86400,
    secure: new URL(request.url).protocol === 'https:',
  });
  return c.json({ ok: true });
}
