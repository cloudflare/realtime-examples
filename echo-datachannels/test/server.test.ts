import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { startExampleServer } from "../server.ts";
import {
  SfuApiClient,
  type CreateDataChannelOptions,
  type SfuApiOperations,
} from "../sfu-api.ts";

type RecordedCall =
  | readonly ["createSession"]
  | readonly ["createDataChannel", CreateDataChannelOptions];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createSfuClient(
  overrides: Partial<SfuApiOperations>,
): SfuApiOperations {
  const unused = async (): Promise<never> => {
    throw new Error("Unused SFU client method");
  };
  return {
    createSession: overrides.createSession ?? unused,
    establishDataChannelTransport:
      overrides.establishDataChannelTransport ?? unused,
    renegotiate: overrides.renegotiate ?? unused,
    createDataChannel: overrides.createDataChannel ?? unused,
    closeDataChannels: overrides.closeDataChannels ?? unused,
  };
}

async function start(
  t: TestContext,
  sfuClient: SfuApiOperations,
): Promise<string> {
  const runningServer = await startExampleServer({
    sfuClient,
    port: 0,
    logger: { error(): void {} },
  });
  t.after(() => runningServer.close());
  return runningServer.origin;
}

test("local server handles bounded JSON requests and normalizes responses", async (t) => {
  const calls: RecordedCall[] = [];
  const sfuClient = createSfuClient({
    async createSession() {
      calls.push(["createSession"]);
      return { sessionId: "session_1" };
    },
    async createDataChannel(options) {
      calls.push(["createDataChannel", options]);
      if (
        options.location !== "remote" ||
        options.publisherSessionId === undefined
      ) {
        throw new Error("Expected the remote DataChannel test request");
      }
      return {
        dataChannel: {
          id: 4,
          profile: options.profileId,
          location: options.location,
          dataChannelName: "reliable-ordered",
          ordered: true,
          sessionId: options.publisherSessionId,
          waitForAck: true,
          canReply: true,
        },
      };
    },
  });
  const origin = await start(t, sfuClient);

  const sessionResponse = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(sessionResponse.status, 201);
  const sessionContentType =
    sessionResponse.headers.get("content-type") ?? "";
  assert.match(sessionContentType, /^application\/json/);
  assert.deepEqual(await sessionResponse.json(), { sessionId: "session_1" });

  const channelResponse = await fetch(
    `${origin}/api/sessions/subscriber_1/datachannels`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "reliable-ordered",
        location: "remote",
        publisherSessionId: "publisher_1",
      }),
    },
  );
  assert.equal(channelResponse.status, 201);
  const channelPayload = (await channelResponse.json()) as {
    dataChannel: unknown;
  };
  assert.deepEqual(channelPayload.dataChannel, {
    id: 4,
    profile: "reliable-ordered",
    location: "remote",
    dataChannelName: "reliable-ordered",
    ordered: true,
    sessionId: "publisher_1",
    waitForAck: true,
    canReply: true,
  });
  assert.deepEqual(calls, [
    ["createSession"],
    [
      "createDataChannel",
      {
        sessionId: "subscriber_1",
        profileId: "reliable-ordered",
        location: "remote",
        publisherSessionId: "publisher_1",
      },
    ],
  ]);
});

test("local server rejects missing JSON content type and unknown fields", async (t) => {
  let callCount = 0;
  const origin = await start(
    t,
    createSfuClient({
      async createSession() {
        callCount += 1;
        return { sessionId: "session_1" };
      },
      async createDataChannel() {
        callCount += 1;
        throw new Error("should not be called");
      },
    }),
  );

  const missingContentType = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(missingContentType.status, 415);
  const missingContentTypePayload =
    (await missingContentType.json()) as {
      error: { code: string };
    };
  assert.equal(
    missingContentTypePayload.error.code,
    "content_type_required",
  );

  const unknownField = await fetch(
    `${origin}/api/sessions/subscriber_1/datachannels`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "reliable-ordered",
        location: "remote",
        publisherSessionId: "publisher_1",
        rawSfuPath: "/anything",
      }),
    },
  );
  assert.equal(unknownField.status, 400);
  const unknownFieldPayload = (await unknownField.json()) as {
    error: { code: string };
  };
  assert.equal(unknownFieldPayload.error.code, "invalid_request");
  assert.equal(callCount, 0);
});

test("server responses never echo the SFU app ID, token, or upstream description", async (t) => {
  const appId = "private-test-app";
  const token = "unit-test-token";
  const upstreamDescription = "sensitive-upstream-detail";
  const sfuClient = new SfuApiClient({
    appId,
    token,
    fetchImpl: async () =>
      jsonResponse(
        {
          errorCode: "authorization_failed",
          errorDescription: `${upstreamDescription} ${token}`,
        },
        401,
      ),
  });
  const origin = await start(t, sfuClient);

  const response = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(appId));
  assert.doesNotMatch(text, new RegExp(token));
  assert.doesNotMatch(text, new RegExp(upstreamDescription));
  assert.match(text, /authorization_failed/);
});

test("server exposes only generated browser JavaScript without credentials", async (t) => {
  const origin = await start(
    t,
    createSfuClient({
      async createSession() {
        throw new Error("unused");
      },
    }),
  );

  for (const path of ["/", "/app.js", "/styles.css"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /Bearer unit-test-token/);
    assert.doesNotMatch(text, /Authorization\s*:/);
    assert.doesNotMatch(text, /private-test-app/);
  }

  for (const path of [
    "/app.ts",
    "/client.ts",
    "/channel-config.ts",
    "/server.ts",
    "/sfu-api.ts",
    "/session-mutations.ts",
    "/scan-generated.ts",
    "/app.mjs",
    "/dist/app.js",
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404);
  }
});
