import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/sfu.mjs';

test(
  'production bundle authenticates, serves RPC and dispatches the actual lease alarm',
  { timeout: 60000 },
  async (t) => {
    let expired = false;
    const h = await createHarness(t, ({ path }) =>
      expired && path.endsWith('/close')
        ? Response.json({ errorCode: 'session_error' }, { status: 410 })
        : undefined,
    );
    assert.equal((await h.call('/status')).status, 401);
    await h.login();
    await h.start();
    const viewer = await h.viewer();
    assert.equal((await h.call(`/viewers/${viewer.id}/claim`, {}, viewer.owner)).status, 200);
    const deadline = Date.now() + 28000;
    while (Date.now() < deadline) {
      await h.status();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal((await h.status()).controller, null);
    assert.ok(
      h.calls.some(
        (call) =>
          call.path.endsWith('/datachannels/update') &&
          call.input.dataChannels[0].canReply === false,
      ),
    );
    expired = true;
    await h.start({ bootId: 'b'.repeat(32) });
    assert.equal((await h.status()).viewers, 0);
  },
);
