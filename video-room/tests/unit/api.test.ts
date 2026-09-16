import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { ApiError, RoomApi } from "../../src/client/api";
import type { JoinResponse } from "../../src/shared/protocol";

const joined: JoinResponse = {
  generation: 1,
  memberToken: "m".repeat(43),
  participantId: "p_alice",
  snapshot: {
    creatorParticipantId: "p_alice",
    participants: [{ displayName: "Alice", id: "p_alice", published: [] }],
    revision: 1,
    roomId: "example-room",
    terminated: false,
  },
};

function browser(t: TestContext): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("http://localhost/rooms/example-room"),
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "location", original);
    else Reflect.deleteProperty(globalThis, "location");
  });
}

test("join validates the response before replacing membership", async (t) => {
  browser(t);
  let response = Response.json(
    { ...joined, generation: "1" },
    {
      status: 201,
      headers: { "x-request-id": "response-ray" },
    },
  );
  const fetch = t.mock.method(globalThis, "fetch", async () => response);
  const api = new RoomApi("example-room", "alice");
  api.memberToken = "previous-membership";
  await assert.rejects(
    api.join("client-alice", "Alice", joined.memberToken),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "response_invalid");
      assert.equal(error.status, 201);
      assert.equal(error.requestId, "response-ray");
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(api.memberToken, "previous-membership");
  assert.equal(fetch.mock.callCount(), 1);
  response = Response.json(joined, { status: 201 });
  await api.join("client-alice", "Alice", joined.memberToken);
  assert.equal(api.memberToken, joined.memberToken);
});

test("an immediate subscription response must include its offer", async (t) => {
  browser(t);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      mutationId: "subscribe-alice",
      requiresImmediateRenegotiation: true,
      subscriptions: [],
    }),
  );
  await assert.rejects(
    new RoomApi("example-room", "alice").subscribe(1, "subscribe-alice", []),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === "response_invalid" &&
      !error.retryable,
  );
});

test("HTTP errors retain their status and diagnostics without exposing malformed bodies", async (t) => {
  browser(t);
  let response = new Response("<html>untrusted response</html>", {
    status: 503,
    headers: { "x-request-id": "header-ray" },
  });
  t.mock.method(globalThis, "fetch", async () => response);
  const api = new RoomApi("example-room", "alice");
  await assert.rejects(api.snapshot(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 503);
    assert.equal(error.requestId, "header-ray");
    assert.equal(error.retryable, false);
    assert.equal(error.message, "The room returned an invalid response.");
    return true;
  });
  response = Response.json(
    {
      error: {
        code: "room_terminating",
        message: "The room is closing.",
        retryable: true,
        requestId: "body-ray",
      },
    },
    { status: 409 },
  );
  await assert.rejects(api.snapshot(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "room_terminating");
    assert.equal(error.status, 409);
    assert.equal(error.retryable, true);
    assert.equal(error.requestId, "body-ray");
    return true;
  });
});

test("timeouts and cancellation also cover reading a response body", async (t) => {
  browser(t);
  let bodyStarted: () => void = () => {};
  t.mock.method(
    globalThis,
    "fetch",
    async (
      _url: Parameters<typeof globalThis.fetch>[0],
      options?: RequestInit,
    ) => {
      const signal = options!.signal!;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"revision":'));
            signal.addEventListener(
              "abort",
              () => controller.error(signal.reason),
              { once: true },
            );
            bodyStarted();
          },
        }),
      );
    },
  );
  await assert.rejects(
    new RoomApi("example-room", "alice", 1).snapshot(),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === "client_request_timed_out" &&
      error.retryable,
  );
  const reading = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const controller = new AbortController();
  const pending = new RoomApi("example-room", "alice").snapshot(
    controller.signal,
  );
  await reading;
  controller.abort(new DOMException("Cancelled body read", "AbortError"));
  await assert.rejects(
    pending,
    (error: unknown) => error === controller.signal.reason,
  );
});
