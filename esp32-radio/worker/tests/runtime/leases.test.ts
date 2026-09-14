import { expect, test, vi } from 'vitest';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { createHarness } from './harness.ts';

test('failed revocation retains the controller until a successful retry', async () => {
  let failRevoke = false;
  const h = await createHarness(({ path, input }) =>
    path.endsWith('/datachannels/update') && input.dataChannels[0].canReply === false && failRevoke
      ? Response.json({ errorCode: 'retry_later' }, { status: 503 })
      : undefined,
  );
  await h.login();
  await h.start();
  const a = await h.viewer(),
    b = await h.viewer();
  expect((await h.call(`/viewers/${a.id}/claim`, {}, a.owner)).status).toBe(200);
  failRevoke = true;
  expect((await h.call(`/viewers/${a.id}/release`, {}, a.owner)).status).toBe(502);
  expect((await h.status()).controller).toBe(a.id);
  expect((await h.call(`/viewers/${b.id}/claim`, {}, b.owner)).status).toBe(409);
  failRevoke = false;
  expect((await h.call(`/viewers/${a.id}/release`, {}, a.owner)).status).toBe(200);
  expect((await h.call(`/viewers/${b.id}/claim`, {}, b.owner)).status).toBe(200);
});

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
