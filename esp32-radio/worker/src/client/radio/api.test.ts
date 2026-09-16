import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createRadioApi } from './api.ts';

test('status operations reject malformed successful responses before exposing state', async () => {
  const api = createRadioApi(async () => Response.json({ online: true, viewers: 'many' }));
  await assert.rejects(
    api.getStatus(),
    (error: unknown) => error instanceof ApiError && error.status === 502,
  );
});

test('viewer answers send the session capability and validate channel settings', async () => {
  const member = { id: 'viewer', viewerToken: 'viewer-capability' };
  const answer = { type: 'answer' as const, sdp: 'v=0' };
  let conflicting = false;
  const api = createRadioApi(async (url, init) => {
    assert.equal(url, '/api/viewers/viewer/answer');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(new Headers(init?.headers).get('X-Viewer-Token'), member.viewerToken);
    assert.deepEqual(JSON.parse(String(init?.body)), { sessionDescription: answer });
    return Response.json({
      channels: [
        { id: 1, dataChannelName: 'robot', ...(conflicting ? { ordered: false } : {}) },
        { id: 3, dataChannelName: 'spectrum' },
      ],
    });
  });
  assert.deepEqual((await api.answerViewer(member, answer)).channels, [
    { id: 1, dataChannelName: 'robot', ordered: true },
    { id: 3, dataChannelName: 'spectrum', ordered: false, maxRetransmits: 0 },
  ]);
  conflicting = true;
  await assert.rejects(api.answerViewer(member, answer), ApiError);
});

test('API failures preserve authentication status and handle non-JSON errors', async () => {
  const unauthorized = createRadioApi(async () =>
    Response.json({ error: 'Access required.' }, { status: 401 }),
  );
  await assert.rejects(
    unauthorized.getStatus(),
    (error: unknown) =>
      error instanceof ApiError && error.status === 401 && error.message === 'Access required.',
  );
  const unavailable = createRadioApi(async () => new Response('Unavailable', { status: 503 }));
  await assert.rejects(
    unavailable.getStatus(),
    (error: unknown) => error instanceof ApiError && error.status === 503,
  );
});
