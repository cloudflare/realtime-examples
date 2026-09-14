import { expect, test } from 'vitest';
import { createHarness, device, offer, startedSchema } from './harness.ts';

test('partial channel allocations survive eviction and failed cleanup before retry', async () => {
  let partial = true,
    failClose = false;
  const h = await createHarness(({ path }) => {
    if (path.endsWith('/datachannels/new') && partial)
      return Response.json({
        dataChannels: [
          { id: 2, dataChannelName: 'robot' },
          { dataChannelName: 'spectrum', errorCode: 'creation_error' },
        ],
      });
    if (path.endsWith('/datachannels/close') && failClose)
      return Response.json({ errorCode: 'retry_later' }, { status: 503 });
  });
  const started = await h.call(
    '/device/start',
    { sessionDescription: offer, bootId: 'a'.repeat(32) },
    device,
  );
  const identity = { generation: startedSchema.parse(await started.json()).generation };
  expect((await h.call('/device/channels', identity, device)).status).toBe(502);
  expect((await h.call('/device/ready', identity, device)).status).toBe(409);
  await h.evict();
  failClose = true;
  const allocations = h.calls.filter((c) => c.path.endsWith('/datachannels/new')).length;
  expect((await h.call('/device/channels', identity, device)).status).toBe(502);
  expect(h.calls.filter((c) => c.path.endsWith('/datachannels/new')).length).toBe(allocations);
  partial = false;
  failClose = false;
  expect((await h.call('/device/channels', identity, device)).status).toBe(200);
  expect(
    h.calls.some(
      (c) =>
        c.path.endsWith('/datachannels/close') &&
        JSON.stringify(c.input.dataChannels) === '[{"id":2}]',
    ),
  ).toBeTruthy();
  expect((await h.call('/device/ready', identity, device)).status).toBe(200);
});

test('channel profile validation retains all returned IDs for replacement cleanup', async () => {
  let invalid = true;
  const h = await createHarness(({ path }) => {
    if (path.endsWith('/datachannels/new') && invalid)
      return Response.json({
        dataChannels: [
          { id: 2, dataChannelName: 'robot', ordered: false },
          { id: 4, dataChannelName: 'spectrum' },
        ],
      });
  });
  const response = await h.call(
    '/device/start',
    { sessionDescription: offer, bootId: 'a'.repeat(32) },
    device,
  );
  const identity = { generation: startedSchema.parse(await response.json()).generation };
  expect((await h.call('/device/channels', identity, device)).status).toBe(502);
  await h.evict();
  invalid = false;
  await h.start({ bootId: 'b'.repeat(32) });
  expect(
    h.calls.some(
      (c) =>
        c.path.endsWith('/datachannels/close') &&
        JSON.stringify(c.input.dataChannels) === '[{"id":2},{"id":4}]',
    ),
  ).toBeTruthy();
});

for (const failure of ['bad SDP', 'item error']) {
  test(`audio allocation is retained before rejecting ${failure}`, async () => {
    const h = await createHarness(({ path, input }) => {
      if (path.endsWith('/tracks/new') && input.tracks[0].location === 'remote')
        return Response.json({
          sessionDescription: failure === 'bad SDP' ? { type: 'offer', sdp: 'invalid' } : offer,
          tracks: [{ mid: '7', ...(failure === 'item error' ? { errorCode: 'track_error' } : {}) }],
        });
    });
    await h.login();
    await h.start();
    const v = await h.viewer();
    expect((await h.call(`/viewers/${v.id}/audio`, {}, v.owner)).status).toBe(502);
    await h.evict();
    expect((await h.call(`/viewers/${v.id}/leave`, {}, v.owner)).status).toBe(200);
    expect(
      h.calls.some(
        (c) =>
          c.path.endsWith('/tracks/close') && c.input.tracks.some((track) => track.mid === '7'),
      ),
    ).toBeTruthy();
    expect((await h.status()).viewers).toBe(0);
  });
}

test('already expired SFU sessions do not prevent a replacement publisher', async () => {
  let expired = false;
  const h = await createHarness(({ path }) =>
    expired && path.endsWith('/close')
      ? Response.json({ errorCode: 'session_error' }, { status: 410 })
      : undefined,
  );
  await h.login();
  await h.start();
  await h.viewer();
  expired = true;
  await h.start({ bootId: 'b'.repeat(32) });
  expect((await h.status()).viewers).toBe(0);
});
