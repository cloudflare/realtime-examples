import type { IncomingHttpHeaders } from 'node:http';
import type { ProxyOptions } from 'vite';

const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

export function backendOrigin(value?: string) {
  try {
    const url = new URL(value ?? '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error("Set VOICE_BACKEND_URL in .env.local to your deployed Worker's HTTPS origin.");
  }
}

export function localProxyRequest(method: string | undefined, headers: IncomingHttpHeaders) {
  try {
    const origin = new URL(`http://${headers.host}`);
    if (
      !loopback.has(origin.hostname) ||
      origin.host !== headers.host ||
      headers['sec-fetch-site'] === 'cross-site'
    )
      return false;
    if (headers.origin) return headers.origin === origin.origin;
    return method === 'GET' || method === 'HEAD';
  } catch {
    return false;
  }
}

export function localCookie(cookie: string) {
  // Only the loopback proxy uses HTTP. Deployed cookies keep Secure, and local
  // cookies retain HttpOnly and SameSite; nothing is copied into browser JS.
  return cookie.replace(/;\s*Secure(?=;|$)/gi, '');
}

export function liveProxy(target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    cookieDomainRewrite: '',
    proxyTimeout: 100_000,
    bypass(request) {
      return localProxyRequest(request.method, request.headers) ? undefined : false;
    },
    configure(proxy) {
      proxy.on('proxyReq', (upstream, request) => {
        if (request.headers.origin) upstream.setHeader('Origin', target);
      });
      proxy.on('proxyRes', (response) => {
        const cookies = response.headers['set-cookie'];
        if (cookies) response.headers['set-cookie'] = cookies.map(localCookie);
      });
    },
  };
}
