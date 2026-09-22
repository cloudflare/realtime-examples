import { expect, test } from 'vitest';
import { createHarness, device, offer, track, nowPlaying } from './harness.ts';

for (const [name, fields, conflictStatus] of [
  ['legacy', { track }, 409],
  ['playlist only', { nowPlaying }, 400],
  ['both', { track, nowPlaying }, 400],
] as const) {
  test(`${name} startup is idempotent across concurrent calls and eviction`, async () => {
    const h = await createHarness();
    const input = { sessionDescription: offer, bootId: 'a'.repeat(32), ...fields };
    const [first, second] = await Promise.all([
      h.call('/device/start', input, device),
      h.call('/device/start', input, device),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const publisher = await first.json();
    expect(await second.json()).toEqual(publisher);
    expect(h.allocations()).toBe(1);
    await h.evict();
    expect(await (await h.call('/device/start', input, device)).json()).toEqual(publisher);
    expect(h.allocations()).toBe(1);
    expect(
      (
        await h.call(
          '/device/start',
          { ...input, sessionDescription: { ...offer, sdp: offer.sdp + 'a=x:changed\r\n' } },
          device,
        )
      ).status,
    ).toBe(409);
    expect(
      (await h.call('/device/start', { ...input, track: { ...track, title: 'Changed' } }, device))
        .status,
    ).toBe(conflictStatus);
  });
}

test('metadata follows song changes without reallocating sessions and preserves startup identity', async () => {
  const h = await createHarness();
  await h.login();
  const { input, publisher, identity } = await h.start({ nowPlaying });
  const viewer = await h.viewer();
  const before = h.calls.length;
  const next = { ...nowPlaying, revision: 1, trackIndex: 1, track: { ...track, title: 'Next' } };
  expect(
    (await h.call('/device/heartbeat', { ...identity, nowPlaying: next }, device)).status,
  ).toBe(200);
  let state = await h.status();
  expect(state.nowPlaying).toEqual(next);
  expect(state.generation).toBe(publisher.generation);
  expect(state.viewers).toBe(1);
  expect(h.calls.length).toBe(before);
  await h.call('/device/heartbeat', { ...identity, nowPlaying }, device);
  expect((await h.status()).nowPlaying).toEqual(next);
  expect(
    (
      await h.call(
        '/device/heartbeat',
        { ...identity, nowPlaying: { ...next, trackIndex: 2 } },
        device,
      )
    ).status,
  ).toBe(409);
  await h.evict();
  expect((await h.status()).nowPlaying).toEqual(next);
  expect(await (await h.call('/device/start', input, device)).json()).toEqual(publisher);
  expect((await h.call(`/viewers/${viewer.id}/heartbeat`, {}, viewer.owner)).status).toBe(200);
  await h.start({ bootId: 'b'.repeat(32) });
  state = await h.status();
  expect(state.track).toBe(null);
  expect(state.nowPlaying).toBe(null);
  expect((await h.call('/device/heartbeat', identity, device)).status).toBe(409);
});

test('a replacement boot discards the old generation without contacting its SFU sessions', async () => {
  let obsolete = false;
  const oldSession = /\/sessions\/session-[12](?:\/|$)/;
  const h = await createHarness(({ path }) =>
    obsolete && oldSession.test(path)
      ? Response.json({ errorCode: 'internal_error' }, { status: 503 })
      : undefined,
  );
  await h.login();
  const previous = await h.start();
  const oldViewer = await h.viewer();
  expect((await h.call(`/viewers/${oldViewer.id}/claim`, {}, oldViewer.owner)).status).toBe(200);
  await h.evict();
  obsolete = true;
  const before = h.calls.length;
  const replacement = await h.start({ bootId: 'b'.repeat(32) });
  expect(replacement.identity.generation).not.toBe(previous.identity.generation);
  expect(await h.status()).toMatchObject({
    ...replacement.identity,
    online: true,
    viewers: 0,
    controller: null,
  });
  expect(h.calls.slice(before).some((call) => oldSession.test(call.path))).toBe(false);
  const currentViewer = await h.viewer();
  expect((await h.call(`/viewers/${currentViewer.id}/claim`, {}, currentViewer.owner)).status).toBe(
    200,
  );
  const after = h.calls.length;
  for (const operation of ['heartbeat', 'channels', 'ready'])
    expect((await h.call(`/device/${operation}`, previous.identity, device)).status).toBe(409);
  for (const operation of ['heartbeat', 'claim', 'release', 'leave', 'audio'])
    expect(
      (await h.call(`/viewers/${oldViewer.id}/${operation}`, {}, oldViewer.owner)).status,
    ).toBe(403);
  expect(h.calls).toHaveLength(after);
  expect((await h.status()).controller).toBe(currentViewer.id);
  await h.evict();
  expect(await (await h.call('/device/start', replacement.input, device)).json()).toEqual(
    replacement.publisher,
  );
  expect(h.allocations()).toBe(4);
});

test('failed replacement allocation cannot restore the retired generation after eviction', async () => {
  let failAllocation = false;
  const h = await createHarness(({ path }) =>
    failAllocation && path.endsWith('/sessions/new')
      ? Response.json({ errorCode: 'temporarily_unavailable_error' }, { status: 503 })
      : undefined,
  );
  await h.login();
  const previous = await h.start();
  const oldViewer = await h.viewer();
  expect((await h.call(`/viewers/${oldViewer.id}/claim`, {}, oldViewer.owner)).status).toBe(200);
  failAllocation = true;
  const input = { sessionDescription: offer, bootId: 'b'.repeat(32) };
  expect((await h.call('/device/start', input, device)).status).toBe(502);
  await h.evict();
  expect(await h.status()).toMatchObject({
    online: false,
    generation: null,
    viewers: 0,
    controller: null,
  });
  expect((await h.call('/device/heartbeat', previous.identity, device)).status).toBe(409);
  expect((await h.call(`/viewers/${oldViewer.id}/heartbeat`, {}, oldViewer.owner)).status).toBe(
    403,
  );
  failAllocation = false;
  await h.start(input);
  expect((await h.status()).online).toBe(true);
});

test('an invalid replacement offer leaves the current generation usable', async () => {
  const h = await createHarness();
  await h.login();
  const previous = await h.start();
  const viewer = await h.viewer();
  const before = h.calls.length;
  expect(
    (
      await h.call(
        '/device/start',
        { sessionDescription: { ...offer, sdp: 'v=0\r\n' }, bootId: 'b'.repeat(32) },
        device,
      )
    ).status,
  ).toBe(400);
  expect(h.calls).toHaveLength(before);
  expect((await h.call('/device/heartbeat', previous.identity, device)).status).toBe(200);
  expect((await h.call(`/viewers/${viewer.id}/heartbeat`, {}, viewer.owner)).status).toBe(200);
  expect(await h.status()).toMatchObject({ ...previous.identity, online: true, viewers: 1 });
});
