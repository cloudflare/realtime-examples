import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  answerInputSchema,
  emptySchema,
  leaveSchema,
  viewerKeySchema,
} from '@/shared/contracts/signaling.ts';
import { demand } from '@/server/rpc.ts';
import type { HttpApp } from '@/server/http.ts';
import { input, result, room } from './context.ts';

const app = new Hono<HttpApp>();
function viewer(c: Context<HttpApp>, beaconToken?: string) {
  const key = viewerKeySchema.safeParse({
    id: c.req.param('id'),
    token: c.req.header('X-Viewer-Token') ?? beaconToken,
  });
  demand(key.success, 403, 'This browser does not own that viewer session.');
  return key.data;
}

app.post('/', async (c) => {
  await input(c, emptySchema);
  return result(c, await room(c).joinViewer());
});
app.post('/:id/answer', async (c) =>
  result(
    c,
    await room(c).answerViewer(viewer(c), (await input(c, answerInputSchema)).sessionDescription),
  ),
);
app.post('/:id/renegotiate', async (c) =>
  result(
    c,
    await room(c).renegotiateViewer(
      viewer(c),
      (await input(c, answerInputSchema)).sessionDescription,
    ),
  ),
);
app.post('/:id/leave', async (c) => {
  const { viewerToken } = await input(c, leaveSchema);
  return result(c, await room(c).leaveViewer(viewer(c, viewerToken)));
});
app.post('/:id/audio', async (c) => {
  await input(c, emptySchema);
  return result(c, await room(c).subscribeAudio(viewer(c)));
});
app.post('/:id/heartbeat', async (c) => {
  await input(c, emptySchema);
  return result(c, await room(c).heartbeatViewer(viewer(c)));
});
app.post('/:id/claim', async (c) => {
  await input(c, emptySchema);
  return result(c, await room(c).claimControl(viewer(c)));
});
app.post('/:id/release', async (c) => {
  await input(c, emptySchema);
  return result(c, await room(c).releaseControl(viewer(c)));
});

export default app;
