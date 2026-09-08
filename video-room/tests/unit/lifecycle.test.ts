import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../src/client/api";
import {
  ClientLifecycleController,
  retryBounded,
  type ClientLifecycleTransition,
} from "../../src/client/lifecycle";
import { SerialMutationQueue } from "../../src/client/mutation-queue";

test("leave and terminate supersede reconnect without stale commits", async () => {
  for (const terminal of ["leave", "terminate"] as const) {
    const changes: Array<ClientLifecycleTransition | undefined> = [];
    const lifecycle = new ClientLifecycleController((transition) => {
      changes.push(transition);
    });
    let reconnectSignal: AbortSignal | undefined;
    let releaseReconnect!: () => void;
    let staleCommit = false;
    const reconnectBlocked = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    const reconnect = lifecycle.run("reconnect", async (transition) => {
      reconnectSignal = transition.signal;
      await reconnectBlocked;
      transition.commit(() => {
        staleCommit = true;
      });
    });
    await Promise.resolve();

    let terminalCommitted = false;
    await lifecycle.run(terminal, async (transition) => {
      transition.commit(() => {
        terminalCommitted = true;
      });
    });

    assert.equal(reconnectSignal?.aborted, true);
    assert.equal(terminalCommitted, true);
    assert.equal(staleCommit, false);
    assert.equal(lifecycle.active, undefined);
    releaseReconnect();
    await reconnect;
    assert.equal(staleCommit, false);
    assert.deepEqual(changes, ["reconnect", terminal, undefined]);
  }
});

test("non-terminal lifecycle work is single-owner and can restart after leave", async () => {
  const lifecycle = new ClientLifecycleController();
  let releaseJoin!: () => void;
  const joinBlocked = new Promise<void>((resolve) => {
    releaseJoin = resolve;
  });
  let duplicateRan = false;
  const firstJoin = lifecycle.run("join", async () => {
    await joinBlocked;
  });
  const duplicateJoin = lifecycle.run("resume", async () => {
    duplicateRan = true;
  });

  assert.strictEqual(duplicateJoin, firstJoin);
  releaseJoin();
  await firstJoin;
  assert.equal(duplicateRan, false);

  await lifecycle.run("leave", async () => undefined);
  let freshJoinRan = false;
  await lifecycle.run("join", async (transition) => {
    transition.commit(() => {
      freshJoinRan = true;
    });
  });
  assert.equal(freshJoinRan, true);
});

test("closing the browser queue rejects waiting work and drains one active task", async () => {
  const queue = new SerialMutationQueue();
  let releaseActive!: () => void;
  const activeBlocked = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const active = queue.enqueue(async () => {
    await activeBlocked;
    return "active-complete";
  });
  const waiting = queue.enqueue(async () => "must-not-run");
  const waitingRejected = assert.rejects(waiting, /queue closed/);
  const idle = queue.onIdle();
  let idleResolved = false;
  void idle.then(() => {
    idleResolved = true;
  });

  queue.close("queue closed");
  await waitingRejected;
  await Promise.resolve();
  assert.equal(idleResolved, false);
  releaseActive();
  assert.equal(await active, "active-complete");
  await idle;
  assert.equal(idleResolved, true);
});

test("closing the browser queue prevents an active failure from retrying", async () => {
  let attempts = 0;
  let retryScheduled!: () => void;
  const retryStarted = new Promise<void>((resolve) => {
    retryScheduled = resolve;
  });
  const queue = new SerialMutationQueue(() => {
    retryScheduled();
    return {
      delayMs: 60_000,
      retry: true,
    };
  });
  const active = queue.enqueue(async () => {
    attempts += 1;
    throw new Error("retryable");
  });
  const rejected = assert.rejects(active, /media closed/);

  await retryStarted;
  const idle = queue.onIdle();
  queue.close("media closed");
  await rejected;
  await idle;
  assert.equal(attempts, 1);
});

test("bounded room setup retry recovers from one transient failure", async () => {
  const attempts: number[] = [];
  const retries: number[] = [];
  const result = await retryBounded(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt === 0) {
        throw new ApiError(
          "sfu_request_timed_out",
          "temporary failure",
          true,
        );
      }
      return "connected";
    },
    (error) => error instanceof ApiError && error.retryable,
    async (_error, attempt) => {
      retries.push(attempt);
    },
  );
  assert.equal(result, "connected");
  assert.deepEqual(attempts, [0, 1]);
  assert.deepEqual(retries, [0]);
});
