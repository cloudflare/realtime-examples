import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSameOrigin,
  authenticateRequest,
  RequestError,
} from "../../src/server/auth";
import { API_HEADER_LOCAL_IDENTITY } from "../../src/shared/protocol";

test("accepts an explicit localhost development identity", async () => {
  const request = new Request("http://localhost:8787/api/rooms/demo/join", {
    headers: { [API_HEADER_LOCAL_IDENTITY]: "alice-local" },
  });
  assert.deepEqual(await authenticateRequest(request, { AUTH_MODE: "local" }), {
    displayHint: "alice-local",
    subject: "local:alice-local",
  });
});

test("missing authentication mode fails closed", async () => {
  const request = new Request("http://localhost:8787/api/rooms/demo/join", {
    headers: { [API_HEADER_LOCAL_IDENTITY]: "alice-local" },
  });
  await assert.rejects(
    authenticateRequest(request, {}),
    (error: unknown) =>
      error instanceof RequestError &&
      error.code === "auth_mode_missing" &&
      error.status === 503,
  );
});

test("local identity mode fails closed on a deployed host", async () => {
  const request = new Request("https://room.example.com/api/rooms/demo/join", {
    headers: { [API_HEADER_LOCAL_IDENTITY]: "alice-local" },
  });
  await assert.rejects(
    authenticateRequest(request, { AUTH_MODE: "local" }),
    (error: unknown) =>
      error instanceof RequestError &&
      error.code === "local_auth_unavailable" &&
      error.status === 503,
  );
});

test("rejects cross-origin mutations", () => {
  const request = new Request("https://room.example.com/api/rooms/demo/join", {
    headers: {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
    method: "POST",
  });
  assert.throws(
    () => assertSameOrigin(request),
    (error: unknown) =>
      error instanceof RequestError && error.code === "cross_origin_request",
  );
});
