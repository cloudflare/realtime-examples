import { expect, test } from 'vitest';
import { createHarness, offer } from './harness.ts';

test('typed RPC preserves startup identity across eviction and returns expected errors as data', async () => {
  const h = createHarness();
  const input = { bootId: 'a'.repeat(32), sessionDescription: offer };
  const first = await h.room.startDevice(input);
  expect(first.ok).toBe(true);
  expect(h.calls).toHaveLength(2);
  await h.evict();
  expect(await h.room.startDevice(input)).toEqual(first);
  expect(h.calls).toHaveLength(2);
  expect(await h.room.deviceHeartbeat('stale-generation')).toMatchObject({
    ok: false,
    status: 409,
  });
});
