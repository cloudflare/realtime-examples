import { env, exports as workerExports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import worker from "../../src/worker";
import type { ApiErrorBody, JoinResponse } from "../../src/shared/protocol";
import { network } from "./network";

const ORIGIN = "http://localhost";
const joinCommand = {
  clientId: "client-alice",
  displayName: "Alice",
  memberToken: "m".repeat(43),
};
const publishCommand = {
  generation: 1,
  mutationId: "publish-alice",
  sessionDescription: { type: "offer", sdp: "v=0" },
  tracks: [{ kind: "audio", mid: "0" }],
};

function request(
  action: string,
  body?: unknown,
  headers?: HeadersInit,
): Request {
  return new Request(`${ORIGIN}/api/rooms/http-test/${action}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-video-room-local-identity": "alice",
      ...headers,
    },
    method: "POST",
  });
}

function sessionCreation(): string[] {
  const sessions: string[] = [];
  network.use(
    http.post(
      "https://rtc.live.cloudflare.com/v1/apps/:appId/sessions/new",
      () => {
        const sessionId = `http-session-${sessions.length + 1}`;
        sessions.push(sessionId);
        return HttpResponse.json({ sessionId }, { status: 201 });
      },
    ),
  );
  return sessions;
}

test.each([
  ["join", null, "body_invalid"],
  ["publish", { ...publishCommand, generation: "1" }, "generation_invalid"],
])(
  "%s shape rejection happens at HTTP before room effects (%s)",
  async (action, body, code) => {
    const sessions = sessionCreation();
    const response = await workerExports.default.fetch(
      request(action as string, body),
    );
    expect(response.status).toBe(400);
    const payload = await response.json<ApiErrorBody>();
    expect(payload.error.code).toBe(code);
    expect(payload.error.retryable).toBe(false);
    expect(payload.error.requestId).toBe(response.headers.get("x-request-id"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(payload)).not.toContain(joinCommand.memberToken);
    expect(sessions).toHaveLength(0);
    await runInDurableObject(
      env.ROOMS.getByName("http-test"),
      async (_instance, state) => {
        expect(await state.storage.get("room")).toBeUndefined();
      },
    );
  },
);

test.each([undefined, null])(
  "join normalizes the display hint and tolerates extra fields (%s)",
  async (displayName) => {
    const sessions = sessionCreation();
    const response = await workerExports.default.fetch(
      request("join", { ...joinCommand, displayName, extra: true }),
    );
    expect(response.status).toBe(201);
    const joined = await response.json<JoinResponse>();
    expect(joined.snapshot.participants[0]?.displayName).toBe(
      displayName ?? "alice",
    );
    expect(sessions).toHaveLength(2);
  },
);

test("JSON bodies remain accepted without a content-type header", async () => {
  sessionCreation();
  const raw = request("join", joinCommand);
  raw.headers.delete("content-type");
  const response = await workerExports.default.fetch(raw);
  expect(response.status).toBe(201);
});

test("authentication precedes body decoding and validation", async () => {
  const raw = new Request(`${ORIGIN}/api/rooms/http-test/join`, {
    body: "not-json",
    method: "POST",
    headers: { origin: ORIGIN },
  });
  const response = await workerExports.default.fetch(raw);
  expect(response.status).toBe(401);
  expect((await response.json<ApiErrorBody>()).error.code).toBe(
    "local_identity_required",
  );
});

test.each([
  { origin: "https://elsewhere.example", "sec-fetch-site": "same-origin" },
  { origin: ORIGIN, "sec-fetch-site": "cross-site" },
])(
  "either disallowed origin signal rejects JSON mutations and socket upgrades",
  async (headers) => {
    for (const action of ["join", "socket"]) {
      const raw =
        action === "join"
          ? request(action, joinCommand, headers)
          : new Request(`${ORIGIN}/api/rooms/http-test/socket`, {
              headers: { ...headers, upgrade: "websocket" },
            });
      const response = await workerExports.default.fetch(raw);
      expect(response.status).toBe(403);
      expect((await response.json<ApiErrorBody>()).error.code).toBe(
        "cross_origin_request",
      );
    }
  },
);

test("Ray IDs correlate responses and cannot replace retry-stable reconnect IDs", async () => {
  const sessions = sessionCreation();
  const join = await workerExports.default.fetch(
    request("join", joinCommand, {
      "cf-ray": "0123456789abcdef-SJC",
      "x-request-id": "caller-override",
    }),
  );
  expect(join.headers.get("x-request-id")).toBe("0123456789abcdef-SJC");
  const joined = await join.json<JoinResponse>();
  const command = {
    clientId: joinCommand.clientId,
    displayName: "Alice",
    requestId: "stable-reconnect-id",
  };
  for (const ray of ["first-reconnect-ray", "second-reconnect-ray"]) {
    const response = await workerExports.default.fetch(
      request("reconnect", command, {
        "cf-ray": ray,
        "x-room-member-token": joined.memberToken,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(ray);
    expect((await response.json<JoinResponse>()).generation).toBe(2);
  }
  expect(sessions).toHaveLength(4);
});

test("socket errors keep the front door's diagnostic ID", async () => {
  const response = await workerExports.default.fetch(
    new Request(`${ORIGIN}/api/rooms/http-test/socket`, {
      headers: {
        origin: ORIGIN,
        upgrade: "websocket",
        "cf-ray": "socket-test-ray",
      },
    }),
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("x-request-id")).toBe("socket-test-ray");
  expect((await response.json<ApiErrorBody>()).error).toMatchObject({
    code: "socket_ticket_required",
    requestId: "socket-test-ray",
  });
});

test("body limits check declared and actual bytes, even on ignored request bodies", async () => {
  for (const [body, length] of [
    ["{}", "1100001"],
    ["x".repeat(1_100_001), "2"],
  ] as const) {
    const raw = new Request(`${ORIGIN}/api/rooms/http-test/heartbeat`, {
      body,
      method: "POST",
      headers: {
        origin: ORIGIN,
        "x-video-room-local-identity": "alice",
        ...(length ? { "content-length": length } : {}),
      },
    });
    const response = await worker.fetch(raw, env);
    expect(response.status).toBe(413);
    expect((await response.json<ApiErrorBody>()).error.code).toBe(
      "body_too_large",
    );
  }
});

test("room routing keeps explicit methods and asset fallback", async () => {
  for (const [path, method, status] of [
    ["/api/rooms/http-test/snapshot", "POST", 404],
    ["/api/rooms/http-test/snapshot", "HEAD", 404],
    ["/api/rooms/http-test/unknown", "GET", 404],
  ] as const) {
    const response = await worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { "x-video-room-local-identity": "alice" },
      }),
      env,
    );
    expect(response.status, `${method} ${path}`).toBe(status);
  }
  const assetPaths: string[] = [];
  const bindings = {
    ...env,
    ASSETS: {
      fetch: async (raw: Request) => {
        assetPaths.push(new URL(raw.url).pathname);
        return new Response("asset");
      },
    } as Fetcher,
  };
  for (const path of ["/rooms/http-test", "/api/rooms/http-test/snapshot/"]) {
    const response = await worker.fetch(
      new Request(`${ORIGIN}${path}`),
      bindings,
    );
    expect(await response.text()).toBe("asset");
  }
  expect(assetPaths).toHaveLength(2);
});
