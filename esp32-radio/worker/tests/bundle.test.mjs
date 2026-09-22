import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/sfu.mjs';

test(
  'production bundle authenticates, expires leases and replaces obsolete sessions independently',
  { timeout: 60000 },
  async (t) => {
    let expired = false;
    const h = await createHarness(t, ({ path }) => {
      if (expired && /\/sessions\/session-[12](?:\/|$)/.test(path))
        return Response.json({ errorCode: 'internal_error' }, { status: 503 });
    });
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
    const before = h.calls.length;
    await h.start({ bootId: 'b'.repeat(32) });
    const status = await h.status();
    assert.equal(status.viewers, 0);
    assert.equal(status.online, true);
    assert.equal(
      h.calls.slice(before).some((call) => /\/sessions\/session-[12](?:\/|$)/.test(call.path)),
      false,
    );
  },
);
