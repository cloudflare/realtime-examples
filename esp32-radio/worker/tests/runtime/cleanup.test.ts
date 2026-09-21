import { expect, test, vi } from 'vitest';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
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

test('channel profile validation retains all returned IDs for retry within the same generation', async () => {
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
  expect((await h.call('/device/channels', identity, device)).status).toBe(200);
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

test('item-level absence completes viewer cleanup in the current generation', async () => {
  let absent = false;
  const h = await createHarness(({ path, input }) => {
    if (!absent) return;
    if (path.endsWith('/tracks/close'))
      return Response.json({
        tracks: input.tracks.map(({ mid }) => ({ mid, errorCode: 'close_track_error' })),
      });
    if (path.endsWith('/datachannels/close'))
      return Response.json({
        dataChannels: input.dataChannels.map(({ id }) => ({ id, errorCode: 'close_track_error' })),
      });
  });
  await h.login();
  const { identity } = await h.start();
  const v = await h.viewer();
  expect((await h.call(`/viewers/${v.id}/audio`, {}, v.owner)).status).toBe(200);
  await h.evict();
  absent = true;
  expect((await h.call(`/viewers/${v.id}/leave`, {}, v.owner)).status).toBe(200);
  expect(await h.status()).toMatchObject({ ...identity, online: true, viewers: 0 });
  expect((await h.call(`/viewers/${v.id}/heartbeat`, {}, v.owner)).status).toBe(403);
});

test('cleanup logs SFU error codes without including response details or SDP', async () => {
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = await createHarness(({ path }) =>
    path.endsWith('/tracks/close')
      ? Response.json({
          errorCode: 'session_error',
          errorDescription: 'private upstream detail',
          sessionDescription: offer,
          tracks: [{ mid: '0', errorCode: 'track_error' }],
        })
      : undefined,
  );
  await h.login();
  await h.start();
  const v = await h.viewer();
  expect((await h.call(`/viewers/${v.id}/audio`, {}, v.owner)).status).toBe(200);
  expect((await h.call(`/viewers/${v.id}/leave`, {}, v.owner)).status).toBe(200);
  expect(warnings).toHaveBeenCalledWith(
    JSON.stringify({
      phase: 'sfu',
      operation: 'tracks/close',
      status: 200,
      errorCode: 'session_error',
      trackErrorCodes: ['track_error'],
    }),
  );
  expect(JSON.stringify(warnings.mock.calls)).not.toContain('private upstream detail');
  expect(JSON.stringify(warnings.mock.calls)).not.toContain('UDP/TLS/RTP');
});

for (const failure of [
  {
    name: 'item error',
    status: 200,
    payload: { tracks: [{ mid: '0', errorCode: 'internal_error' }] },
  },
  { name: 'request-level close error', status: 200, payload: { errorCode: 'close_track_error' } },
  { name: 'HTTP 404 app error', status: 404, payload: { errorCode: 'app_error' } },
  { name: 'HTTP 410 session error', status: 410, payload: { errorCode: 'session_error' } },
]) {
  test(`${failure.name} retains viewer cleanup across eviction while its publisher remains current`, async () => {
    let failClose = true;
    const h = await createHarness(({ path }) => {
      if (failClose && path.endsWith('/tracks/close'))
        return Response.json(failure.payload, { status: failure.status });
    });
    await h.login();
    const { identity } = await h.start();
    const v = await h.viewer();
    expect((await h.call(`/viewers/${v.id}/audio`, {}, v.owner)).status).toBe(200);
    expect((await h.call(`/viewers/${v.id}/leave`, {}, v.owner)).status).toBe(200);
    expect((await h.call(`/viewers/${v.id}/heartbeat`, {}, v.owner)).status).toBe(409);
    // Suspend the real timer while forcing eviction; status restores the scheduled retry.
    await runInDurableObject(h.room, (_instance, state) => state.storage.deleteAlarm());
    await h.evict();
    failClose = false;
    await h.status();
    expect(await runDurableObjectAlarm(h.room)).toBe(true);
    expect((await h.call(`/viewers/${v.id}/heartbeat`, {}, v.owner)).status).toBe(403);
    expect(h.calls.filter((call) => call.path.endsWith('/tracks/close'))).toHaveLength(2);
    expect(h.calls.some((call) => /\/sessions\/session-\d+$/.test(call.path))).toBe(false);
    expect(h.allocations()).toBe(2);
    expect(await h.status()).toMatchObject({ ...identity, online: true, viewers: 0 });
  });
}
