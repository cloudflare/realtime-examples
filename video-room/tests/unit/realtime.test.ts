import assert from "node:assert/strict";
import test from "node:test";

import {
  RealtimeSfuClient,
  SfuRequestError,
  isRetryableSfuStatus,
  sanitizeErrorIdentifier,
  sfuResponseError,
} from "../../src/server/realtime";

const env = {
  REALTIME_SFU_APP_ID: "<test-app-id>",
  REALTIME_SFU_BEARER_TOKEN: "<test-token>",
};

test("SFU retryability follows HTTP status semantics", () => {
  assert.equal(isRetryableSfuStatus(429), true);
  assert.equal(isRetryableSfuStatus(500), true);
  assert.equal(isRetryableSfuStatus(503), true);
  assert.equal(isRetryableSfuStatus(400), false);
  assert.equal(isRetryableSfuStatus(404), false);
  assert.equal(isRetryableSfuStatus(406), false);
});

test("uses the actual HTTP status and a bounded provider error message", async () => {
  const client = new RealtimeSfuClient(
    env,
    async () =>
      Response.json(
        {
          errorCode: "provider_error",
          errorDescription: "Raw provider detail must not reach the browser.",
        },
        { status: 429 },
      ),
  );
  await assert.rejects(
    client.addTracks("session", {}),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.code === "provider_error" &&
      error.status === 429 &&
      error.retryable &&
      error.message === "Realtime SFU could not complete the operation." &&
      !error.message.includes("Raw provider detail"),
  );
});

test("ordinary SFU HTTP 4xx responses are not retryable", async () => {
  const client = new RealtimeSfuClient(
    env,
    async () =>
      Response.json(
        {
          errorCode: "provider_error",
          errorDescription: "A provider-specific rejection.",
        },
        { status: 400 },
      ),
  );
  await assert.rejects(
    client.addTracks("session", {}),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.status === 400 &&
      error.retryable === false &&
      error.message === "Realtime SFU rejected the operation.",
  );
});

test("an error embedded in HTTP 200 becomes a generic upstream failure", async () => {
  const client = new RealtimeSfuClient(
    env,
    async () =>
      Response.json({
        errorCode: "provider_error",
        errorDescription: "A provider-specific internal explanation.",
      }),
  );
  await assert.rejects(
    client.addTracks("session", {}),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.code === "provider_error" &&
      error.status === 502 &&
      error.retryable &&
      error.message === "Realtime SFU could not complete the operation." &&
      !error.message.includes("internal explanation"),
  );
});

test("an unreadable HTTP error body still preserves the actual status", async () => {
  const client = new RealtimeSfuClient(
    env,
    async () => new Response("not-json", { status: 410 }),
  );
  await assert.rejects(
    client.closeTracks("session", ["missing"]),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.code === "sfu_upstream_error" &&
      error.status === 410 &&
      error.retryable === false,
  );
});

test("preserves repeatable per-track close results returned under HTTP 200", async () => {
  const requestBodies: unknown[] = [];
  const client = new RealtimeSfuClient(env, async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      requiresImmediateRenegotiation: false,
      tracks: [
        {
          mid: "missing-mid",
          errorCode: "close_track_error",
          errorDescription: "Provider wording is not part of convergence.",
        },
      ],
    });
  });

  const first = await client.closeTracks("session", ["missing-mid"]);
  const second = await client.closeTracks("session", ["missing-mid"]);
  const expected = {
    requiresImmediateRenegotiation: false,
    tracks: [
      {
        mid: "missing-mid",
        errorCode: "close_track_error",
        errorDescription: "Provider wording is not part of convergence.",
      },
    ],
  };

  assert.deepEqual(requestBodies, [
    { force: true, tracks: [{ mid: "missing-mid" }] },
    { force: true, tracks: [{ mid: "missing-mid" }] },
  ]);
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
});

test("bounds provider error identifiers before exposing them", () => {
  assert.equal(sanitizeErrorIdentifier("provider_error"), "provider_error");
  assert.equal(sanitizeErrorIdentifier("provider-error"), undefined);
});

test("retains only bounded public track locators for safe diagnostics", () => {
  const error = sfuResponseError(
    {
      errorCode: "pull_failed",
      mid: "remote-0",
      trackName: "p_abc-2-video",
    },
    "pull failed",
  );
  assert.deepEqual(error.track, {
    mid: "remote-0",
    trackName: "p_abc-2-video",
  });

  const unsafe = sfuResponseError(
    {
      errorCode: "pull_failed",
      mid: "remote\n0",
      trackName: "x".repeat(129),
    },
    "pull failed",
  );
  assert.equal(unsafe.track, undefined);
});

test("aborts an SFU request after the configured timeout", async () => {
  const fetcher: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () =>
        reject(new DOMException("The operation was aborted.", "AbortError"));
      if (!signal) {
        reject(new Error("missing abort signal"));
      } else if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  const client = new RealtimeSfuClient(env, fetcher, 5);

  await assert.rejects(
    client.createSession(),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.code === "sfu_request_timed_out" &&
      error.status === 504 &&
      error.retryable,
  );
});
