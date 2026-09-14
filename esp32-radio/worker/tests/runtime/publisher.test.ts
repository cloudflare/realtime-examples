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
