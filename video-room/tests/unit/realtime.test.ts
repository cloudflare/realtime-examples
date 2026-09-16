import assert from "node:assert/strict";
import test from "node:test";

import {
  RealtimeSfuClient,
  SfuRequestError,
  parseSfuTracksResponse,
} from "../../src/server/realtime";

const env = {
  REALTIME_SFU_APP_ID: "<test-app-id>",
  REALTIME_SFU_BEARER_TOKEN: "<test-token>",
};

test("uses the actual HTTP status and a bounded provider error message", async () => {
  const client = new RealtimeSfuClient(
    env,
    async () =>
      Response.json(
        {
          errorCode: "provider-error",
          errorDescription: "Raw provider detail must not reach the browser.",
        },
        { status: 429 },
      ),
  );
  await assert.rejects(
    client.addTracks("session", {}),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.code === "sfu_upstream_error" &&
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
        mid: "remote\n0",
        trackName: "x".repeat(129),
        errorDescription: "A provider-specific internal explanation.",
      }),
  );
  const response = await client.addTracks("session", {});
  assert.throws(
    () => parseSfuTracksResponse(response, "publish"),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.code === "provider_error" &&
      error.track === undefined &&
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

test("forwards per-track close results returned under HTTP 200", async () => {
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

  const response = await client.closeTracks("session", ["missing-mid"]);
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
  ]);
  assert.deepEqual(response, expected);
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
