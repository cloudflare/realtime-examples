import test from "node:test";
import assert from "node:assert/strict";

import {
  ExampleApi,
  ExampleError,
  TeardownManager,
  createBrowserChannelWithTrackedId,
  type DataChannelLike,
  type PeerConnectionLike,
  sendJsonMessage,
  teardownAfterSetup,
  waitForDataChannelOpen,
  waitForPeerConnectionConnected,
  waitForSetupOperations,
} from "../client.ts";
import { SfuApiClient } from "../sfu-api.ts";

interface CloseCall {
  sessionId: string;
  channelIds: readonly number[];
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected a JSON string request body");
  }
  return JSON.parse(init.body) as unknown;
}

function shiftValue<Value>(values: Value[]): Value {
  const value = values.shift();
  if (value === undefined) {
    throw new Error("Test response queue was exhausted");
  }
  return value;
}

function createDeferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

class FakeDataChannel extends EventTarget implements DataChannelLike {
  readonly label: string;
  readyState: RTCDataChannelState = "connecting";
  closeCalls = 0;
  readonly sent: string[] = [];

  constructor(label: string) {
    super();
    this.label = label;
  }

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  send(value: string): void {
    if (this.readyState !== "open") {
      throw new Error("not open");
    }
    this.sent.push(value);
  }
}

class FakePeerConnection
  extends EventTarget
  implements PeerConnectionLike
{
  connectionState: RTCPeerConnectionState = "new";
  closeCalls = 0;

  connect(): void {
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  close(): void {
    this.closeCalls += 1;
    this.connectionState = "closed";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

test("default browser fetch uses globalThis as its receiver", async () => {
  const originalFetch = globalThis.fetch;
  let receiver: unknown;
  try {
    globalThis.fetch = function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      receiver = this;
      return Promise.resolve(jsonResponse({ sessionId: "session_1" }));
    };

    assert.deepEqual(await new ExampleApi().createSession(), {
      sessionId: "session_1",
    });
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("state helpers wait for connected and open before resolving", async () => {
  const peerConnection = new FakePeerConnection();
  const dataChannel = new FakeDataChannel("reliable-ordered");
  const connected = waitForPeerConnectionConnected(peerConnection, {
    timeoutMs: 100,
  });
  const opened = waitForDataChannelOpen(dataChannel, { timeoutMs: 100 });

  peerConnection.connect();
  dataChannel.open();

  assert.equal(await connected, "connected");
  assert.equal(await opened, "open");
});

test("browser API rejects invalid content types and exposes actionable JSON errors", async () => {
  const invalidResponseApi = new ExampleApi({
    fetchImpl: async () =>
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
  });
  await assert.rejects(
    () => invalidResponseApi.createSession(),
    (error) =>
      error instanceof ExampleError &&
      error.code === "invalid_server_response" &&
      error.message.includes("application/json"),
  );

  const actionableErrorApi = new ExampleApi({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "sfu_request_failed",
            message: "Check the server-side Realtime SFU credentials.",
          },
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        },
      ),
  });
  await assert.rejects(
    () => actionableErrorApi.createSession(),
    (error) =>
      error instanceof ExampleError &&
      error.code === "sfu_request_failed" &&
      error.message.includes("server-side Realtime SFU credentials"),
  );
});

test("teardown waits for late parallel setup before cleaning up a failed setup", async () => {
  const lateSetup = createDeferred();
  const channelIds = new Set<number>();
  const events: string[] = [];
  const remoteCalls: CloseCall[] = [];
  const manager = new TeardownManager({
    api: {
      async closeDataChannels(sessionId, ids) {
        events.push("teardown");
        remoteCalls.push({ sessionId, channelIds: ids });
        return { closedIds: ids };
      },
    },
    getRemoteGroups: () => [
      {
        sessionId: "late_session",
        channelIds: [...channelIds],
      },
    ],
    getDataChannels: () => [],
    getPeerConnections: () => [],
  });

  const setupOperation = waitForSetupOperations([
    Promise.reject(new Error("publisher setup failed")),
    (async () => {
      await lateSetup.promise;
      channelIds.add(7);
      events.push("late-setup-complete");
    })(),
  ]);
  const setupOutcome = setupOperation.then(
    () => "fulfilled",
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
  let teardownSettled = false;
  const teardownOperation = teardownAfterSetup(
    setupOperation,
    () => manager.teardown(),
  ).finally(() => {
    teardownSettled = true;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(teardownSettled, false);
  assert.deepEqual(remoteCalls, []);

  lateSetup.resolve();
  assert.equal(await setupOutcome, "publisher setup failed");
  assert.deepEqual(await teardownOperation, {
    alreadyClosed: false,
    remoteSessionsClosed: 1,
  });
  assert.deepEqual(events, ["late-setup-complete", "teardown"]);
  assert.deepEqual(remoteCalls, [
    { sessionId: "late_session", channelIds: [7] },
  ]);
});

test("browser channel construction failure leaves the returned ID retryable", async () => {
  const channelIds = new Set<number>();
  const remoteCalls: CloseCall[] = [];
  const manager = new TeardownManager({
    api: {
      async closeDataChannels(sessionId, ids) {
        remoteCalls.push({ sessionId, channelIds: ids });
        return { closedIds: ids };
      },
    },
    getRemoteGroups: () => [
      {
        sessionId: "publisher_session",
        channelIds: [...channelIds],
      },
    ],
    getDataChannels: () => [],
    getPeerConnections: () => [],
  });

  assert.deepEqual(await manager.teardown(), {
    alreadyClosed: true,
    remoteSessionsClosed: 0,
  });

  const returnedChannelId = 9;
  assert.throws(
    () =>
      createBrowserChannelWithTrackedId(
        channelIds,
        returnedChannelId,
        () => {
          throw new Error("browser createDataChannel failed");
        },
      ),
    /createDataChannel failed/,
  );
  assert.deepEqual([...channelIds], [returnedChannelId]);
  assert.equal(manager.isFullyClosed(), false);

  assert.deepEqual(await manager.teardown(), {
    alreadyClosed: false,
    remoteSessionsClosed: 1,
  });
  assert.deepEqual(await manager.teardown(), {
    alreadyClosed: true,
    remoteSessionsClosed: 1,
  });
  assert.deepEqual(remoteCalls, [
    {
      sessionId: "publisher_session",
      channelIds: [returnedChannelId],
    },
  ]);
});

test("teardown closes remote and local resources once and stops sends", async () => {
  const remoteCalls: CloseCall[] = [];
  const channels = [
    new FakeDataChannel("publisher-reliable"),
    new FakeDataChannel("subscriber-reliable"),
    new FakeDataChannel("publisher-state"),
    new FakeDataChannel("subscriber-state"),
  ];
  channels.forEach((channel) => channel.open());
  const peerConnections = [
    new FakePeerConnection(),
    new FakePeerConnection(),
  ];
  peerConnections.forEach((connection) => connection.connect());
  const groups = [
    { sessionId: "publisher_session", channelIds: [3, 5] },
    { sessionId: "subscriber_session", channelIds: [4, 6] },
  ];
  const manager = new TeardownManager({
    api: {
      async closeDataChannels(sessionId, channelIds) {
        remoteCalls.push({ sessionId, channelIds });
        return { closedIds: channelIds };
      },
    },
    getRemoteGroups: () => groups,
    getDataChannels: () => channels,
    getPeerConnections: () => peerConnections,
  });

  assert.deepEqual(await manager.teardown(), {
    alreadyClosed: false,
    remoteSessionsClosed: 2,
  });
  assert.deepEqual(await manager.teardown(), {
    alreadyClosed: true,
    remoteSessionsClosed: 2,
  });
  assert.deepEqual(remoteCalls, groups);
  assert.deepEqual(
    channels.map((channel) => channel.closeCalls),
    [1, 1, 1, 1],
  );
  assert.deepEqual(
    peerConnections.map((connection) => connection.closeCalls),
    [1, 1],
  );
  assert.throws(
    () => sendJsonMessage(channels[0], { message: "too late" }),
    /not open/,
  );
});

test("teardown retries only the remote cleanup group that failed", async () => {
  const calls: CloseCall[] = [];
  let subscriberAttempts = 0;
  const channel = new FakeDataChannel("reliable");
  channel.open();
  const peerConnection = new FakePeerConnection();
  peerConnection.connect();
  const manager = new TeardownManager({
    api: {
      async closeDataChannels(sessionId, channelIds) {
        calls.push({ sessionId, channelIds });
        if (
          sessionId === "subscriber_session" &&
          subscriberAttempts++ === 0
        ) {
          throw new Error("temporary cleanup failure");
        }
        return { closedIds: channelIds };
      },
    },
    getRemoteGroups: () => [
      { sessionId: "publisher_session", channelIds: [1] },
      { sessionId: "subscriber_session", channelIds: [2] },
    ],
    getDataChannels: () => [channel],
    getPeerConnections: () => [peerConnection],
  });

  await assert.rejects(() => manager.teardown(), /Retry teardown/);
  assert.equal(channel.closeCalls, 1);
  assert.equal(peerConnection.closeCalls, 1);

  const result = await manager.teardown();
  assert.equal(result.remoteSessionsClosed, 2);
  assert.deepEqual(
    calls.map((call) => call.sessionId),
    ["publisher_session", "subscriber_session", "subscriber_session"],
  );
  assert.equal(channel.closeCalls, 1);
  assert.equal(peerConnection.closeCalls, 1);
});

test("partial upstream close succeeds on retry without closing local objects twice", async () => {
  const requests: unknown[] = [];
  const responses = [
    {
      dataChannels: [
        { id: 3 },
        {
          id: 5,
          errorCode: "backend_error",
          errorDescription: "temporary close failure",
        },
      ],
    },
    {
      dataChannels: [
        {
          id: 3,
          errorCode: "close_track_error",
          errorDescription: "DataChannel was already closed",
        },
        { id: 5 },
      ],
    },
  ];
  const api = new SfuApiClient({
    appId: "test-app",
    token: "unit-test-token",
    fetchImpl: async (_url, init) => {
      requests.push(parseRequestBody(init));
      return jsonResponse(shiftValue(responses));
    },
  });
  const channel = new FakeDataChannel("reliable");
  channel.open();
  const peerConnection = new FakePeerConnection();
  peerConnection.connect();
  const manager = new TeardownManager({
    api,
    getRemoteGroups: () => [
      { sessionId: "publisher_session", channelIds: [3, 5] },
    ],
    getDataChannels: () => [channel],
    getPeerConnections: () => [peerConnection],
  });

  await assert.rejects(() => manager.teardown(), /Retry teardown/);
  assert.equal(channel.closeCalls, 1);
  assert.equal(peerConnection.closeCalls, 1);

  assert.deepEqual(await manager.teardown(), {
    alreadyClosed: false,
    remoteSessionsClosed: 1,
  });
  assert.deepEqual(await manager.teardown(), {
    alreadyClosed: true,
    remoteSessionsClosed: 1,
  });
  assert.deepEqual(requests, [
    { dataChannels: [{ id: 3 }, { id: 5 }] },
    { dataChannels: [{ id: 3 }, { id: 5 }] },
  ]);
  assert.equal(channel.closeCalls, 1);
  assert.equal(peerConnection.closeCalls, 1);
});
