import { expect, test, vi } from 'vitest';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { createHarness, device } from './harness.ts';

for (const status of [503, 404, 410]) {
  test(`HTTP ${status} revocation failure retains the controller until a successful retry`, async () => {
    // Forced eviction waits in real time; keep this persistence check inside the lease.
    vi.useFakeTimers({ toFake: ['Date'] });
    let failRevoke = false;
    const h = await createHarness(({ path, input }) =>
      path.endsWith('/datachannels/update') &&
      input.dataChannels[0].canReply === false &&
      failRevoke
        ? Response.json({ errorCode: status === 404 ? 'app_error' : 'session_error' }, { status })
        : undefined,
    );
    await h.login();
    await h.start();
    const a = await h.viewer(),
      b = await h.viewer();
    expect((await h.call(`/viewers/${a.id}/claim`, {}, a.owner)).status).toBe(200);
    failRevoke = true;
    expect((await h.call(`/viewers/${a.id}/release`, {}, a.owner)).status).toBe(502);
    // Suspend the real alarm during forced eviction; status restores its schedule.
    await runInDurableObject(h.room, (_instance, state) => state.storage.deleteAlarm());
    await h.evict();
    expect((await h.status()).controller).toBe(a.id);
    expect((await h.call(`/viewers/${b.id}/claim`, {}, b.owner)).status).toBe(409);
    failRevoke = false;
    expect((await h.call(`/viewers/${a.id}/release`, {}, a.owner)).status).toBe(200);
    expect((await h.call(`/viewers/${b.id}/claim`, {}, b.owner)).status).toBe(200);
  });
}

test('status polling keeps the earliest alarm and an expired lease revokes SFU permission', async () => {
  const h = createHarness();
  await h.login();
  await h.start();
  const v = await h.viewer();
  expect((await h.call(`/viewers/${v.id}/claim`, {}, v.owner)).status).toBe(200);
  const scheduled = await runInDurableObject(h.room, (_instance, state) =>
    state.storage.getAlarm(),
  );
  expect(scheduled).not.toBeNull();
  vi.useFakeTimers({ toFake: ['Date'] });
  const now = Date.now();
  for (let i = 1; i <= 5; i++) {
    vi.setSystemTime(now + i * 1000);
    await h.status();
    expect(await runInDurableObject(h.room, (_instance, state) => state.storage.getAlarm())).toBe(
      scheduled,
    );
  }
  vi.setSystemTime(now + 16000);
  expect(await runDurableObjectAlarm(h.room)).toBe(true);
  expect((await h.status()).controller).toBeNull();
  expect(
    h.calls.some(
      (call) =>
        call.path.endsWith('/datachannels/update') && call.input.dataChannels[0].canReply === false,
    ),
  ).toBe(true);
});

test('publisher expiry discards its whole generation and stops cleanup alarms', async () => {
  let expired = false;
  const h = createHarness(() =>
    expired ? Response.json({ errorCode: 'internal_error' }, { status: 503 }) : undefined,
  );
  await h.login();
  const previous = await h.start();
  const viewer = await h.viewer();
  expect((await h.call(`/viewers/${viewer.id}/claim`, {}, viewer.owner)).status).toBe(200);
  const before = h.calls.length;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 91000);
  expired = true;
  expect(await runDurableObjectAlarm(h.room)).toBe(true);
  expect(h.calls).toHaveLength(before);
  await h.evict();
  expect(await h.status()).toMatchObject({
    online: false,
    generation: null,
    viewers: 0,
    controller: null,
  });
  expect(await runInDurableObject(h.room, (_instance, state) => state.storage.getAlarm())).toBe(
    null,
  );
  expect((await h.call('/device/heartbeat', previous.identity, device)).status).toBe(409);
  expect((await h.call(`/viewers/${viewer.id}/heartbeat`, {}, viewer.owner)).status).toBe(403);
  expired = false;
  await h.start({ bootId: 'b'.repeat(32) });
  expect((await h.status()).online).toBe(true);
});
