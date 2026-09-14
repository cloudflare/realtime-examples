import https from 'node:https';
import type { Plugin } from 'vite';
import { allowedProxyRequest, developmentHosts } from './hosts.ts';

/** Opt-in local viewer API proxy. Never included in the deployed Worker. */
export function liveBackend(origin?: string, allowedHosts = developmentHosts()): Plugin {
  const target = origin ? new URL(origin) : undefined;
  if (
    target &&
    (target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.pathname !== '/' ||
      target.search ||
      target.hash)
  ) {
    throw new Error('RADIO_API_ORIGIN must be an HTTPS origin without credentials or a path.');
  }
  return {
    name: 'radio-live-backend',
    apply: 'serve',
    configureServer(server) {
      if (!target) return;
      server.middlewares.use((request, response, next) => {
        if (!/^\/api\/(?:login|status|viewers)(?:[/?]|$)/.test(request.url ?? '')) return next();
        // This middleware runs before Vite's own host check. Validate both host
        // and browser origin before rewriting the upstream origin.
        const host = request.headers.host ?? '';
        if (
          !allowedProxyRequest(
            host,
            request.headers.origin,
            request.headers['sec-fetch-site'],
            allowedHosts,
          )
        ) {
          response.writeHead(403).end('Origin not allowed.');
          return;
        }
        const headers = { ...request.headers, host: target.host, origin: target.origin };
        delete headers.connection;
        const upstream = https.request(
          new URL(request.url!, target),
          {
            method: request.method,
            headers,
            timeout: 26000,
          },
          (result) => {
            const resultHeaders = { ...result.headers };
            // Production cookies stay HttpOnly and SameSite=Strict. Only this
            // explicitly selected HTTP development endpoint needs Secure removed.
            if (resultHeaders['set-cookie'])
              resultHeaders['set-cookie'] = resultHeaders['set-cookie'].map((cookie) =>
                cookie.replace(/;\s*Secure\b/gi, ''),
              );
            response.writeHead(result.statusCode ?? 502, resultHeaders);
            result.pipe(response);
          },
        );
        upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
        upstream.on('error', () => {
          if (!response.headersSent)
            response.writeHead(502, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
          response.end(JSON.stringify({ error: 'The live radio API is unavailable.' }));
        });
        request.on('aborted', () => upstream.destroy());
        request.pipe(upstream);
      });
    },
  };
}
