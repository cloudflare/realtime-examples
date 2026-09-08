import test from "node:test";
import assert from "node:assert/strict";

import { SfuApiClient, SfuApiError } from "../sfu-api.ts";

const SDP_OFFER = {
  type: "offer",
  sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
} as const;

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function captureRequest(
  requests: CapturedRequest[],
  url: string,
  init: RequestInit | undefined,
): void {
  if (!init) {
    throw new TypeError("Expected request init");
  }
  requests.push({ url, init });
}

function getRequest(
  requests: CapturedRequest[],
  index: number,
): CapturedRequest {
  const request = requests[index];
  if (!request) {
    throw new Error(`Missing captured request ${index}`);
  }
  return request;
}

function requestJson(request: CapturedRequest): unknown {
  if (typeof request.init.body !== "string") {
    throw new TypeError("Expected a JSON string request body");
  }
  return JSON.parse(request.init.body) as unknown;
}

function shiftValue<Value>(values: Value[]): Value {
  const value = values.shift();
  if (value === undefined) {
    throw new Error("Test response queue was exhausted");
  }
  return value;
}

test("default SFU fetch uses globalThis as its receiver", async () => {
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

    const client = new SfuApiClient({
      appId: "test-app",
      token: "unit-test-token",
    });
    assert.deepEqual(await client.createSession(), {
      sessionId: "session_1",
    });
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SFU client sends JSON and exact reliability fields for both profiles", async () => {
  const requests: CapturedRequest[] = [];
  const responses = [
    {
      dataChannels: [
        {
          id: 3,
          location: "local",
          dataChannelName: "reliable-ordered",
        },
      ],
    },
    {
      dataChannels: [
        {
          id: 4,
          location: "remote",
          sessionId: "publisher_session",
          dataChannelName: "reliable-ordered",
        },
      ],
    },
    {
      dataChannels: [
        {
          id: 5,
          location: "local",
          dataChannelName: "latest-state",
        },
      ],
    },
    {
      dataChannels: [
        {
          id: 6,
          location: "remote",
          sessionId: "publisher_session",
          dataChannelName: "latest-state",
        },
      ],
    },
  ];
  const client = new SfuApiClient({
    appId: "test-app",
    token: "unit-test-token",
    fetchImpl: async (url, init) => {
      captureRequest(requests, url, init);
      return jsonResponse(shiftValue(responses));
    },
  });

  await client.createDataChannel({
    sessionId: "publisher_session",
    profileId: "reliable-ordered",
    location: "local",
  });
  await client.createDataChannel({
    sessionId: "subscriber_session",
    profileId: "reliable-ordered",
    location: "remote",
    publisherSessionId: "publisher_session",
  });
  await client.createDataChannel({
    sessionId: "publisher_session",
    profileId: "unreliable-unordered",
    location: "local",
  });
  await client.createDataChannel({
    sessionId: "subscriber_session",
    profileId: "unreliable-unordered",
    location: "remote",
    publisherSessionId: "publisher_session",
  });

  for (const request of requests) {
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(
      headers.get("Authorization"),
      "Bearer unit-test-token",
    );
  }
  assert.deepEqual(requestJson(getRequest(requests, 0)), {
    dataChannels: [
      {
        location: "local",
        dataChannelName: "reliable-ordered",
        ordered: true,
      },
    ],
  });
  assert.deepEqual(requestJson(getRequest(requests, 1)), {
    dataChannels: [
      {
        location: "remote",
        dataChannelName: "reliable-ordered",
        ordered: true,
        sessionId: "publisher_session",
        waitForAck: true,
        canReply: true,
      },
    ],
  });
  assert.deepEqual(requestJson(getRequest(requests, 2)), {
    dataChannels: [
      {
        location: "local",
        dataChannelName: "latest-state",
        ordered: false,
        maxRetransmits: 0,
      },
    ],
  });
  assert.deepEqual(requestJson(getRequest(requests, 3)), {
    dataChannels: [
      {
        location: "remote",
        dataChannelName: "latest-state",
        ordered: false,
        maxRetransmits: 0,
        sessionId: "publisher_session",
      },
    ],
  });
});

test("SFU client validates transport, renegotiation, and close responses", async () => {
  const requests: CapturedRequest[] = [];
  const responses = [
    {
      requiresImmediateRenegotiation: true,
      sessionDescription: SDP_OFFER,
      datachannel: {
        id: 0,
        location: "remote",
        dataChannelName: "server-events",
      },
    },
    {},
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
  const client = new SfuApiClient({
    appId: "test-app",
    token: "unit-test-token",
    fetchImpl: async (url, init) => {
      captureRequest(requests, url, init);
      return jsonResponse(shiftValue(responses));
    },
  });

  const transport = await client.establishDataChannelTransport(
    "publisher_session",
  );
  assert.equal(transport.dataChannelId, 0);
  await client.renegotiate("publisher_session", {
    type: "answer",
    sdp: "v=0\r\n",
  });
  assert.deepEqual(
    await client.closeDataChannels("publisher_session", [3, 5]),
    {
      closedIds: [3, 5],
    },
  );

  assert.deepEqual(requestJson(getRequest(requests, 0)), {
    dataChannel: {
      location: "remote",
      dataChannelName: "server-events",
    },
  });
  assert.deepEqual(requestJson(getRequest(requests, 1)), {
    sessionDescription: {
      type: "answer",
      sdp: "v=0\r\n",
    },
  });
  assert.deepEqual(requestJson(getRequest(requests, 2)), {
    dataChannels: [{ id: 3 }, { id: 5 }],
  });
});

test("SFU client preserves sanitized 406 error subcodes for retry classification", async () => {
  const client = new SfuApiClient({
    appId: "test-app",
    token: "unit-test-token",
    fetchImpl: async () =>
      jsonResponse(
        {
          errorCode: "invalid_session_description",
          errorSubcode: "invalid_modification_have_local_offer",
          errorDescription: "session is waiting for an answer",
        },
        406,
      ),
  });

  await assert.rejects(
    () => client.createSession(),
    (error) =>
      error instanceof SfuApiError &&
      error.upstreamStatus === 406 &&
      error.upstreamErrorCode === "invalid_session_description" &&
      error.upstreamErrorSubcode ===
        "invalid_modification_have_local_offer",
  );
});

test("SFU client rejects non-JSON and malformed success responses", async () => {
  const nonJsonClient = new SfuApiClient({
    appId: "test-app",
    token: "unit-test-token",
    fetchImpl: async () =>
      new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
  });
  await assert.rejects(
    () => nonJsonClient.createSession(),
    (error) =>
      error instanceof SfuApiError &&
      error.code === "invalid_sfu_response" &&
      error.message.includes("application/json"),
  );

  const malformedClient = new SfuApiClient({
    appId: "test-app",
    token: "unit-test-token",
    fetchImpl: async () => jsonResponse({ sessionId: null }),
  });
  await assert.rejects(
    () => malformedClient.createSession(),
    (error) =>
      error instanceof SfuApiError &&
      error.code === "invalid_sfu_response" &&
      error.message.includes("sessionId"),
  );
});

test("SFU client does not include upstream descriptions in public errors", async () => {
  const client = new SfuApiClient({
    appId: "test-app",
    token: "unit-test-token",
    fetchImpl: async () =>
      jsonResponse(
        {
          errorCode: "authorization_failed",
          errorDescription: "sensitive-upstream-detail unit-test-token",
        },
        401,
      ),
  });

  await assert.rejects(
    () => client.createSession(),
    (error) =>
      error instanceof SfuApiError &&
      error.code === "sfu_request_failed" &&
      error.message.includes("authorization_failed") &&
      !error.message.includes("sensitive-upstream-detail") &&
      !error.message.includes("unit-test-token"),
  );
});
