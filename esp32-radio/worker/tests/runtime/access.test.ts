import { expect, test } from 'vitest';
import { createHarness } from './harness.ts';

test('access requires authentication, bounded bodies and a matching origin', async () => {
  const h = await createHarness();
  expect((await h.call('/status')).status).toBe(401);
  expect((await h.call('/device/start', {})).status).toBe(401);
  expect((await h.call('/login', { password: 'incorrect' })).status).toBe(401);
  expect((await h.call('/login', ' '.repeat(20001))).status).toBe(413);
  expect(
    (
      await h.call(
        '/login',
        { password: 'test-viewer-password' },
        { Origin: 'https://untrusted.example' },
      )
    ).status,
  ).toBe(403);
  const cookie = await h.login();
  expect(
    cookie.includes('HttpOnly') && cookie.includes('Secure') && cookie.includes('SameSite=Strict'),
  ).toBeTruthy();
  expect((await h.call('/status')).status).toBe(200);
  await h.start();
  const viewer = await h.viewer();
  expect(
    (await h.call(`/viewers/${viewer.id}/claim`, {}, { 'X-Viewer-Token': 'wrong-token' })).status,
  ).toBe(403);
  expect((await h.call(`/viewers/${viewer.id}/claim`, {}, viewer.owner)).status).toBe(200);
});
