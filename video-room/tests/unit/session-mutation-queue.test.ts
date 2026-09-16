import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../src/client/api";
import { SerialMutationQueue } from "../../src/client/mutation-queue";
import {
  SessionMutationQueue,
  SessionQueueError,
} from "../../src/server/session-mutation-queue";
import { deferred } from "./room-harness";

test("keeps add, close, and reconnect serialized through renegotiation", async () => {
  const queue = new SessionMutationQueue(1_000);
  const order: string[] = [];

  const add = queue.enqueue("add-track", async () => {
    order.push("add");
    return {
      response: { offer: "sdp" },
      waitForAnswer: async (answer: string) => {
        order.push(`answer:${answer}`);
      },
    };
  });
  const close = queue.enqueue("close-track", async () => {
    order.push("close");
    return { response: "closed" };
  });
  const reconnect = queue.enqueue("reconnect-session", async () => {
    order.push("reconnect");
    return { response: "reconnected" };
  });

  assert.deepEqual(await add, { offer: "sdp" });
  await Promise.resolve();
  assert.deepEqual(order, ["add"]);
  await queue.complete("add-track", "browser-answer");
  assert.equal(await close, "closed");
  assert.equal(await reconnect, "reconnected");
  assert.deepEqual(order, [
    "add",
    "answer:browser-answer",
    "close",
    "reconnect",
  ]);
});

test("deduplicates a mutation while its answer is pending", async () => {
  const queue = new SessionMutationQueue(1_000);
  let calls = 0;
  const run = () =>
    queue.enqueue("same-id", async () => {
      calls += 1;
      return {
        response: { offer: calls },
        waitForAnswer: async () => undefined,
      };
    });

  assert.deepEqual(await Promise.all([run(), run()]), [
    { offer: 1 },
    { offer: 1 },
  ]);
  await queue.complete("same-id", "answer");
  await queue.complete("same-id", "duplicate-answer");
  assert.deepEqual(await run(), { offer: 1 });
  assert.equal(calls, 1);
});

test("retries a failed renegotiation without releasing queued work", async () => {
  const queue = new SessionMutationQueue(1_000);
  const order: string[] = [];
  let answers = 0;
  await queue.enqueue("subscribe", async () => ({
    response: "offer",
    waitForAnswer: async () => {
      answers += 1;
      order.push(`answer:${answers}`);
      if (answers === 1) throw new Error("temporary SFU failure");
    },
  }));
  const close = queue.enqueue("close", async () => {
    order.push("close");
    return { response: "closed" };
  });

  await assert.rejects(queue.complete("subscribe", "answer"));
  assert.deepEqual(order, ["answer:1"]);
  await queue.complete("subscribe", "answer");
  assert.equal(await close, "closed");
  assert.deepEqual(order, ["answer:1", "answer:2", "close"]);
});

test("times out a missing answer with retryable queued work", async () => {
  const queue = new SessionMutationQueue(15);
  await queue.enqueue("offer", async () => ({
    response: "offer",
    waitForAnswer: async () => undefined,
  }));
  const waiting = queue.enqueue("close", async () => ({ response: "closed" }));
  await assert.rejects(
    waiting,
    (error: unknown) =>
      error instanceof SessionQueueError &&
      error.code === "negotiation_timed_out" &&
      error.retryable,
  );
});

test("evicts response and answer state together before replaying an offer", async () => {
  const queue = new SessionMutationQueue(1_000);
  let answers = 0;
  let offers = 0;
  const runOffer = () =>
    queue.enqueue("evicted-offer", async () => {
      offers += 1;
      return {
        response: `offer-${offers}`,
        waitForAnswer: async () => {
          answers += 1;
        },
      };
    });

  assert.equal(await runOffer(), "offer-1");
  await queue.complete("evicted-offer", "answer-1");
  for (let index = 0; index < 32; index += 1) {
    await queue.enqueue(`plain-${index}`, async () => ({
      response: `plain-${index}`,
    }));
  }

  assert.equal(await runOffer(), "offer-2");
  assert.equal(queue.blockedOperationId, "evicted-offer");
  await queue.complete("evicted-offer", "answer-2");
  assert.equal(queue.blockedOperationId, undefined);
  assert.equal(offers, 2);
  assert.equal(answers, 2);
  assert.equal(
    await queue.enqueue("after-replay", async () => ({ response: "done" })),
    "done",
  );
});

test("restored blocked state deduplicates answers until ledger eviction", async () => {
  const queue = new SessionMutationQueue(1_000);
  const answers: string[] = [];
  queue.restoreBlocked("restored-offer", async (answer: string) => {
    answers.push(answer);
  });

  await queue.complete("restored-offer", "first-answer");
  await queue.complete("restored-offer", "duplicate-answer");
  assert.deepEqual(answers, ["first-answer"]);
  assert.equal(queue.blockedOperationId, undefined);
  await queue.onIdle();

  for (let index = 0; index < 32; index += 1) {
    await queue.enqueue(`replacement-${index}`, async () => ({
      response: index,
    }));
  }
  await assert.rejects(
    queue.complete("restored-offer", "evicted-answer"),
    (error: unknown) =>
      error instanceof SessionQueueError &&
      error.code === "negotiation_not_pending",
  );
});

test("invalidation drains a completing answer without caching its success", async () => {
  const queue = new SessionMutationQueue(1_000);
  const gate = deferred<void>();
  let calls = 0;
  queue.restoreBlocked("restored-offer", async () => {
    calls += 1;
    await gate.promise;
  });
  const completing = Promise.all([
    queue.complete("restored-offer", "answer"),
    queue.complete("restored-offer", "answer"),
  ]);
  let idle = false;
  const drained = queue.onIdle().then(() => { idle = true; });

  queue.invalidate();
  await Promise.resolve();
  assert.equal(idle, false);
  gate.resolve();
  await completing;
  await drained;

  assert.equal(calls, 1);
  assert.equal(idle, true);
  await assert.rejects(queue.complete("restored-offer", "late-answer"),
    (error: unknown) => error instanceof SessionQueueError &&
      error.code === "negotiation_not_pending");
});

test("browser queue retains retryable work and preserves FIFO order", async () => {
  const events: string[] = [];
  let attempts = 0;
  const queue = new SerialMutationQueue((_error, attempt) => ({
    delayMs: 0,
    retry: attempt < 2,
  }));
  const first = queue.enqueue(async () => {
    attempts += 1;
    events.push(`first:${attempts}`);
    if (attempts < 3) throw new Error("signaling unstable");
  });
  const second = queue.enqueue(async () => {
    events.push("second");
  });

  await first;
  await second;
  assert.deepEqual(events, ["first:1", "first:2", "first:3", "second"]);
});

test("browser retry reuses the same mutation ID", async () => {
  const mutationId = "mutation-fixed";
  const observed: string[] = [];
  const queue = new SerialMutationQueue((error, attempt) => ({
    delayMs: 0,
    retry: error instanceof ApiError && error.retryable && attempt < 1,
  }));
  await queue.enqueue(async () => {
    observed.push(mutationId);
    if (observed.length === 1) {
      throw new ApiError(
        "retryable_media_error",
        "The media operation can be retried.",
        true,
        "request-id",
        502,
      );
    }
  });
  assert.deepEqual(observed, [mutationId, mutationId]);
});
