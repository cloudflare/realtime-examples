import { Hono } from 'hono';
import { assertSameOrigin, authenticated } from './auth.ts';
import { equal } from './crypto.ts';
import { demand, OperationError } from './rpc.ts';
import { json } from './http.ts';
import type { HttpApp } from './http.ts';
import access from './routes/access.ts';
import device from './routes/device.ts';
import viewers from './routes/viewers.ts';
export { RobotRoom } from './robot-room.ts';

const app = new Hono<HttpApp>();

app.use('/api/*', async (c, next) => {
  const requestId = crypto.randomUUID(),
    began = Date.now();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  c.header('Cache-Control', 'no-store');
  demand(['GET', 'POST'].includes(c.req.method), 405, 'Method not allowed.');
  assertSameOrigin(c.req.raw);
  if (c.req.path !== '/api/login') {
    if (c.req.path.startsWith('/api/device/')) {
      demand(
        await equal(c.req.header('Authorization') ?? '', `Bearer ${c.env.DEVICE_TOKEN}`),
        401,
        'Device authentication required.',
      );
    } else demand(await authenticated(c), 401, 'Enter the viewer password to listen.');
  }
  await next();
  if (c.res.status >= 500 || (c.req.method === 'POST' && !c.req.path.endsWith('/heartbeat'))) {
    console.log(
      JSON.stringify({
        event: 'request.complete',
        requestId,
        operation: c.req.path.replace(/[a-f0-9-]{36}/g, ':viewer'),
        status: c.res.status,
        durationMs: Date.now() - began,
      }),
    );
  }
});

app.route('/api', access);
app.route('/api/device', device);
app.route('/api/viewers', viewers);

app.all('/api/*', (c) =>
  json(
    { error: 'Unknown radio operation.', requestId: c.get('requestId') },
    c.req.method === 'GET' ? 405 : 404,
  ),
);
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  const status = error instanceof OperationError ? error.status : 500;
  if (status >= 500)
    console.error(JSON.stringify({ phase: 'request', status, requestId: c.get('requestId') }));
  return json(
    {
      error:
        error instanceof OperationError
          ? error.message
          : 'The radio service could not complete this request.',
      requestId: c.get('requestId'),
    },
    status,
  );
});
export default app;
