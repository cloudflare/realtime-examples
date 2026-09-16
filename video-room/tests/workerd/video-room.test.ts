import {
  env,
  exports as workerExports,
} from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  API_HEADER_MEMBER_TOKEN,
  type ApiErrorBody,
  type JoinResponse,
  ROOM_SOCKET_PROTOCOL,
  ROOM_SOCKET_TICKET_PREFIX,
} from "../../src/shared/protocol";
import type { PersistedRoom } from "../../src/server/room";
import type { RoomRpcContext } from "../../src/server/video-room";
import { network } from "./network";

const ORIGIN = "http://localhost";
const MEMBER_TOKEN = "m".repeat(43);

test("join persists creator membership without the raw capability", async () => {
  const sessionRequests = mockSessionCreation();
  const roomId = "workerd-join";
  const joined = await joinRoom(roomId);

  expect(sessionRequests).toHaveLength(2);
  expect(
    sessionRequests.map((request) => request.authorization),
  ).toEqual(["Bearer <test-token>", "Bearer <test-token>"]);
  expect(joined.snapshot.creatorParticipantId).toBe(joined.participantId);

  const stub = env.ROOMS.getByName(roomId);
  await runInDurableObject(stub, async (_instance, state) => {
    const room = await state.storage.get<PersistedRoom>("room");
    const participant = room?.participants[joined.participantId];

    expect(room?.creatorParticipantId).toBe(joined.participantId);
    expect(participant).toMatchObject({
      id: joined.participantId,
      status: "active",
      subject: "local:alice",
    });
    expect(participant?.tokenHash).not.toBe(MEMBER_TOKEN);
    expect(JSON.stringify(room)).not.toContain(MEMBER_TOKEN);
  });
});

test("room operations use RPC while fetch remains socket-only", async () => {
  const roomId = "workerd-rpc";
  const stub = env.ROOMS.getByName(roomId);
  const context = rpcContext("alice");

  await expect(stub.getSnapshot(context)).resolves.toMatchObject({
    error: {
      code: "member_token_required",
      retryable: false,
      status: 401,
    },
    type: "error",
  });

  const nonSocketResponse = await stub.fetch(
    "https://video-room.internal/join",
  );
  expect(nonSocketResponse.status).toBe(404);
  await expect(nonSocketResponse.json<ApiErrorBody>()).resolves.toMatchObject({
    error: { code: "route_not_found" },
  });

  mockSessionCreation();
  const joined = await stub.join(context, {
    clientId: "workerd-client-alice",
    displayName: "Alice",
    memberToken: MEMBER_TOKEN,
  });
  expect(joined.type).toBe("ok");
  if (joined.type === "ok") {
    expect(joined.value.snapshot.roomId).toBe(roomId);
  }
});

test("the HTTP front door rejects invalid and oversized JSON", async () => {
  const headers = {
    "content-type": "application/json",
    origin: ORIGIN,
    "x-video-room-local-identity": "alice",
  };
  const invalidJson = await workerExports.default.fetch(
    new Request(`${ORIGIN}/api/rooms/workerd-json/join`, {
      body: "not-json",
      headers,
      method: "POST",
    }),
  );
  expect(invalidJson.status).toBe(400);
  await expect(invalidJson.json<ApiErrorBody>()).resolves.toMatchObject({
    error: { code: "json_invalid" },
  });

  const oversized = await workerExports.default.fetch(
    new Request(`${ORIGIN}/api/rooms/workerd-json/heartbeat`, {
      body: JSON.stringify({ value: "x".repeat(1_100_000) }),
      headers,
      method: "POST",
    }),
  );
  expect(oversized.status).toBe(413);
  await expect(oversized.json<ApiErrorBody>()).resolves.toMatchObject({
    error: { code: "body_too_large" },
  });
});

test("hibernated notification socket receives revisions after eviction", async () => {
  mockSessionCreation();
  const roomId = "workerd-notifications";
  const alice = await joinRoom(roomId);
  const firstAliceSocket = await openNotificationSocket(roomId, alice, "alice");
  const replaced = new Promise<CloseEvent>((resolve) =>
    firstAliceSocket.addEventListener("close", resolve, { once: true }),
  );
  const aliceSocket = await openNotificationSocket(roomId, alice, "alice");
  const replacement = await replaced;
  expect(replacement.code).toBe(1000);
  expect(replacement.reason).toBe("Replaced by a newer notification socket.");

  const notification = new Promise<unknown>((resolve) =>
    aliceSocket.addEventListener(
      "message",
      (event) => resolve(JSON.parse(String(event.data))),
      { once: true },
    ),
  );
  await evictDurableObject(env.ROOMS.getByName(roomId));
  await joinRoom(roomId, "bob", "b".repeat(43));

  await expect(notification).resolves.toEqual({ revision: 2, type: "room-changed" });
  aliceSocket.close(1000, "Test complete.");
});

test("alarm cleanup persists across Durable Object eviction", async () => {
  mockSessionCreation();
  const roomId = "workerd-stale";
  const joined = await joinRoom(roomId);
  const stub = env.ROOMS.getByName(roomId);

  await runInDurableObject(stub, async (_instance, state) => {
    const room = await state.storage.get<PersistedRoom>("room");
    expect(room).toBeDefined();
    room!.participants[joined.participantId]!.lastSeenAt =
      Date.now() - 60_000;
    await state.storage.put("room", room!);
  });

  await evictDurableObject(stub);
  await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
  await evictDurableObject(stub);

  await runInDurableObject(stub, async (_instance, state) => {
    const room = await state.storage.get<PersistedRoom>("room");
    const participant = room?.participants[joined.participantId];

    expect(room?.revision).toBe(2);
    expect(room?.creatorParticipantId).toBe(joined.participantId);
    expect(participant).toMatchObject({
      consumer: { invalid: true },
      producer: { invalid: true },
      status: "left",
    });
    expect(participant?.leftAt).toEqual(expect.any(Number));
  });
});

test("alarm failure preserves the SFU error and schedules a retry", async () => {
  mockSessionCreation();
  const roomId = "workerd-alarm-failure";
  const joined = await joinRoom(roomId);
  const authenticatedHeaders = {
    [API_HEADER_MEMBER_TOKEN]: joined.memberToken,
    origin: ORIGIN,
    "x-video-room-local-identity": "alice",
  };
  let closeRequests = 0;
  network.use(
    http.post(
      "https://rtc.live.cloudflare.com/v1/apps/:appId/sessions/:sessionId/tracks/new",
      () =>
        HttpResponse.json({
          requiresImmediateRenegotiation: false,
          sessionDescription: { sdp: "answer-sdp", type: "answer" },
          tracks: [{ mid: "0", trackName: `${joined.participantId}-1-video` }],
        }),
    ),
    http.put(
      "https://rtc.live.cloudflare.com/v1/apps/:appId/sessions/:sessionId/tracks/close",
      () => {
        closeRequests += 1;
        return HttpResponse.json(
          {
            errorCode: "alarm_cleanup_failed",
            errorDescription: "Test-only simulated close failure.",
          },
          { status: 503 },
        );
      },
    ),
  );

  const publishResponse = await workerExports.default.fetch(
    new Request(`${ORIGIN}/api/rooms/${roomId}/publish`, {
      body: JSON.stringify({
        generation: joined.generation,
        mutationId: "workerd-alarm-publish",
        sessionDescription: { sdp: "offer-sdp", type: "offer" },
        tracks: [{ kind: "video", mid: "0" }],
      }),
      headers: {
        ...authenticatedHeaders,
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );
  expect(publishResponse.status).toBe(200);

  const terminateResponse = await workerExports.default.fetch(
    new Request(`${ORIGIN}/api/rooms/${roomId}/terminate`, {
      headers: authenticatedHeaders,
      method: "POST",
    }),
  );
  expect(terminateResponse.status).toBe(503);
  expect(closeRequests).toBe(1);

  const stub = env.ROOMS.getByName(roomId);
  const alarmAttemptedAt = Date.now();
  await expect(runDurableObjectAlarm(stub)).rejects.toMatchObject({
    code: "alarm_cleanup_failed",
    message: "Realtime SFU could not complete the operation.",
    status: 503,
  });
  expect(closeRequests).toBe(2);

  await runInDurableObject(stub, async (_instance, state) => {
    const [retryAt, room] = await Promise.all([
      state.storage.getAlarm(),
      state.storage.get<PersistedRoom>("room"),
    ]);

    expect(retryAt).toEqual(expect.any(Number));
    expect(retryAt!).toBeGreaterThanOrEqual(alarmAttemptedAt + 5_000);
    expect(room?.phase).toBe("terminating");
  });
});

function mockSessionCreation(): Array<{
  authorization: string | null;
  url: string;
}> {
  const requests: Array<{
    authorization: string | null;
    url: string;
  }> = [];

  network.use(
    http.post(
      "https://rtc.live.cloudflare.com/v1/apps/:appId/sessions/new",
      ({ request }) => {
        requests.push({
          authorization: request.headers.get("authorization"),
          url: request.url,
        });
        return HttpResponse.json(
          { sessionId: `workerd-session-${requests.length}` },
          { status: 201 },
        );
      },
    ),
  );

  return requests;
}

function rpcContext(identity: string): RoomRpcContext {
  return {
    memberToken: null,
    principal: {
      displayHint: identity.charAt(0).toUpperCase() + identity.slice(1),
      subject: `local:${identity}`,
    },
    requestId: `workerd-rpc-${identity}`,
  };
}

async function openNotificationSocket(
  roomId: string,
  joined: JoinResponse,
  identity: string,
): Promise<WebSocket> {
  const ticketResponse = await workerExports.default.fetch(
    new Request(`${ORIGIN}/api/rooms/${roomId}/socket-ticket`, {
      headers: {
        [API_HEADER_MEMBER_TOKEN]: joined.memberToken,
        origin: ORIGIN,
        "x-video-room-local-identity": identity,
      },
      method: "POST",
    }),
  );
  expect(ticketResponse.status).toBe(200);
  const { ticket } = await ticketResponse.json<{ ticket: string }>();
  const response = await workerExports.default.fetch(
    new Request(`${ORIGIN}/api/rooms/${roomId}/socket`, {
      headers: {
        origin: ORIGIN,
        "sec-websocket-protocol": `${ROOM_SOCKET_PROTOCOL}, ${ROOM_SOCKET_TICKET_PREFIX}${ticket}`,
        upgrade: "websocket",
      },
    }),
  );

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).not.toBeNull();
  socket!.accept();
  return socket!;
}

async function joinRoom(
  roomId: string,
  identity = "alice",
  memberToken = MEMBER_TOKEN,
): Promise<JoinResponse> {
  const response = await workerExports.default.fetch(
    new Request(`${ORIGIN}/api/rooms/${roomId}/join`, {
      body: JSON.stringify({
        clientId: `workerd-client-${identity}`,
        displayName: identity.charAt(0).toUpperCase() + identity.slice(1),
        memberToken,
      }),
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-video-room-local-identity": identity,
      },
      method: "POST",
    }),
  );

  expect(response.status).toBe(201);
  return response.json<JoinResponse>();
}
