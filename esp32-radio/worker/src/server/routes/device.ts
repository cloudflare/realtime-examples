import { Hono } from 'hono';
import {
  deviceHeartbeatSchema,
  deviceStartSchema,
  generationSchema,
} from '@/shared/contracts/signaling.ts';
import type { HttpApp } from '@/server/http.ts';
import { input, result, room } from './context.ts';

const app = new Hono<HttpApp>();
app.post('/start', async (c) =>
  result(c, await room(c).startDevice(await input(c, deviceStartSchema))),
);
app.post('/channels', async (c) =>
  result(c, await room(c).createDeviceChannels((await input(c, generationSchema)).generation)),
);
app.post('/ready', async (c) =>
  result(c, await room(c).deviceReady((await input(c, generationSchema)).generation)),
);
app.post('/heartbeat', async (c) =>
  result(c, await room(c).deviceHeartbeat(await input(c, deviceHeartbeatSchema))),
);

export default app;
