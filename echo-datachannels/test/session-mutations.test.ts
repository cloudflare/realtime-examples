import test from "node:test";
import assert from "node:assert/strict";

import { SessionMutationCoordinator } from "../session-mutations.ts";
import { SfuApiError } from "../sfu-api.ts";

test("per-session queue stays blocked across offer and answer", async () => {
  const events: string[] = [];
  const coordinator = new SessionMutationCoordinator();

  const offer = await coordinator.mutate("session_1", async () => {
    events.push("establish");
    return {
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: "offer", sdp: "v=0\r\n" },
    };
  });
  assert.equal(offer.requiresImmediateRenegotiation, true);
  assert.equal(coordinator.hasPendingRenegotiation("session_1"), true);

  let laterMutationStarted = false;
  const laterMutation = coordinator.mutate("session_1", async () => {
    laterMutationStarted = true;
    events.push("datachannels-new");
    return { ok: true };
  });
  await Promise.resolve();
  assert.equal(laterMutationStarted, false);

  await coordinator.renegotiate("session_1", async () => {
    events.push("renegotiate");
    return { ok: true };
  });
  assert.deepEqual(await laterMutation, { ok: true });
  assert.deepEqual(events, [
    "establish",
    "renegotiate",
    "datachannels-new",
  ]);
  assert.equal(coordinator.hasPendingRenegotiation("session_1"), false);
});

test("overlapping create and teardown mutations stay FIFO per session", async () => {
  const events: string[] = [];
  let releaseCreate!: () => void;
  const createCanFinish = new Promise<void>((resolvePromise) => {
    releaseCreate = resolvePromise;
  });
  const coordinator = new SessionMutationCoordinator();

  const create = coordinator.mutate("session_1", async () => {
    events.push("create-start");
    await createCanFinish;
    events.push("create-finish");
    return { created: true };
  });
  const close = coordinator.mutate("session_1", async () => {
    events.push("close");
    return { closed: true };
  });

  await Promise.resolve();
  assert.deepEqual(events, ["create-start"]);
  releaseCreate();
  assert.deepEqual(await create, { created: true });
  assert.deepEqual(await close, { closed: true });
  assert.deepEqual(events, ["create-start", "create-finish", "close"]);
});

test("unstable signaling rejection is retained and retried in place", async () => {
  let attempts = 0;
  const coordinator = new SessionMutationCoordinator({
    retryDelayMs: 0,
    sleep: async () => {},
  });

  const result = await coordinator.mutate("session_1", async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new SfuApiError(
        "sfu_request_failed",
        "Realtime SFU session is not stable.",
        {
          upstreamStatus: 409,
          upstreamErrorCode: "signaling_state_not_stable",
        },
      );
    }
    return { created: true };
  });

  assert.deepEqual(result, { created: true });
  assert.equal(attempts, 2);
});

test("permanent HTTP 409 track conflict is attempted once", async () => {
  let attempts = 0;
  const coordinator = new SessionMutationCoordinator({
    retryDelayMs: 0,
    sleep: async () => {},
  });

  await assert.rejects(
    () =>
      coordinator.mutate("session_1", async () => {
        attempts += 1;
        throw new SfuApiError(
          "sfu_request_failed",
          "The local track already exists.",
          {
            upstreamStatus: 409,
            upstreamErrorCode: "repeated_local_track_error",
          },
        );
      }),
    /already exists/,
  );
  assert.equal(attempts, 1);
});

const retryable406Errors: ReadonlyArray<{
  errorCode: string;
  errorSubcode?: string;
}> = [
  {
    errorCode: "signaling_state_not_stable",
  },
  {
    errorCode: "invalid_session_description",
  },
  {
    errorCode: "invalid_session_description",
    errorSubcode: "invalid_modification_have_local_offer",
  },
  {
    errorCode: "invalid_session_description",
    errorSubcode: "invalid_modification_have_remote_offer",
  },
  {
    errorCode: "invalid_modification_have_local_pranswer",
  },
  {
    errorCode: "invalid_modification_have_remote_pranswer",
  },
];

for (const error of retryable406Errors) {
  test(`HTTP 406 ${error.errorSubcode ?? error.errorCode} retries in place`, async () => {
    const events: string[] = [];
    let attempts = 0;
    const coordinator = new SessionMutationCoordinator({
      retryDelayMs: 0,
      sleep: async () => {},
    });

    const mutation = coordinator.mutate("session_1", async () => {
      attempts += 1;
      events.push(`mutation-${attempts}`);
      if (attempts === 1) {
        throw new SfuApiError(
          "sfu_request_failed",
          "Realtime SFU session is waiting for negotiation.",
          {
            upstreamStatus: 406,
            upstreamErrorCode: error.errorCode,
            ...(error.errorSubcode === undefined
              ? {}
              : { upstreamErrorSubcode: error.errorSubcode }),
          },
        );
      }
      return { created: true };
    });
    const laterMutation = coordinator.mutate("session_1", async () => {
      events.push("later-mutation");
      return { closed: true };
    });

    assert.deepEqual(await mutation, { created: true });
    assert.deepEqual(await laterMutation, { closed: true });
    assert.deepEqual(events, [
      "mutation-1",
      "mutation-2",
      "later-mutation",
    ]);
  });
}

const nonRetryable406Errors: ReadonlyArray<{
  errorCode: string;
  errorSubcode?: string;
}> = [
  {
    errorCode: "invalid_params",
  },
  {
    errorCode: "invalid_session_description",
    errorSubcode: "invalid_modification_stable",
  },
];

for (const error of nonRetryable406Errors) {
  test(`unrelated HTTP 406 ${error.errorSubcode ?? error.errorCode} is not retried`, async () => {
    let attempts = 0;
    const coordinator = new SessionMutationCoordinator({
      retryDelayMs: 0,
      sleep: async () => {},
    });

    await assert.rejects(
      () =>
        coordinator.mutate("session_1", async () => {
          attempts += 1;
          throw new SfuApiError(
            "sfu_request_failed",
            "Realtime SFU rejected the request.",
            {
              upstreamStatus: 406,
              upstreamErrorCode: error.errorCode,
              ...(error.errorSubcode === undefined
                ? {}
                : { upstreamErrorSubcode: error.errorSubcode }),
            },
          );
        }),
      /rejected/,
    );
    assert.equal(attempts, 1);
  });
}
