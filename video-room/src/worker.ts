import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { requestId } from "hono/request-id";
import type { z } from "zod";

import {
  assertSameOrigin,
  authenticateRequest,
  RequestError,
  type AuthEnv,
} from "./server/auth";
import { errorResponse, rpcResponse } from "./server/http";
import type { RealtimeEnv } from "./server/realtime";
import { type RoomRpcContext, VideoRoom } from "./server/video-room";
import {
  API_HEADER_MEMBER_TOKEN,
  joinRequestSchema,
  publishRequestSchema,
  reconnectRequestSchema,
  renegotiateRequestSchema,
  roomIdSchema,
  subscribeRequestSchema,
} from "./shared/protocol";

export { VideoRoom };

type WorkerEnv = Env & AuthEnv & RealtimeEnv;
type RoomEnv = {
  Bindings: WorkerEnv;
  Variables: {
    requestId: string;
    roomId: string;
    rpc: RoomRpcContext;
    room: DurableObjectStub<VideoRoom>;
  };
};

const MAX_BODY_BYTES = 1_100_000;
const roomRoute = "/:action";
const app = new Hono<RoomEnv>().basePath("/api/rooms/:roomId");

app.use(
  roomRoute,
  requestId({
    // Do not trust a caller's X-Request-Id or mutate WebSocket upgrade headers.
    headerName: "",
    generator: (c) => {
      const ray = c.req.header("cf-ray");
      return ray && /^[\w-]{1,255}$/.test(ray) ? ray : crypto.randomUUID();
    },
  }),
);
app.use(roomRoute, async (c, next) => {
  const roomId = roomIdSchema.safeParse(c.req.param("roomId"));
  if (!roomId.success) {
    throw new RequestError(
      400,
      "room_id_invalid",
      "Room names use lowercase letters, numbers, and hyphens.",
    );
  }
  c.set("roomId", roomId.data);

  if (c.req.method === "GET" && c.req.param("action") === "socket") {
    assertSameOrigin(c.req.raw);
    return next();
  }
  if (c.req.method !== "GET") assertSameOrigin(c.req.raw);
  const principal = await authenticateRequest(c.req.raw, c.env);
  c.set("rpc", {
    memberToken: c.req.header(API_HEADER_MEMBER_TOKEN) ?? null,
    principal,
    requestId: c.get("requestId"),
  });
  // Preserve the API's explicit methods instead of Hono's automatic GET-to-HEAD fallback.
  if (c.req.method === "HEAD") throw routeNotFound();
  if (c.req.method !== "GET") {
    const declaredLength = Number(c.req.header("content-length") ?? 0);
    if (declaredLength > MAX_BODY_BYTES) throw bodyTooLarge();
    // Hono caches these bytes for JSON decoding. Check actual size even when a
    // Content-Length header is present, including bodies ignored by an operation.
    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) throw bodyTooLarge();
  }
  c.set("room", c.env.ROOMS.getByName(roomId.data));
  await next();
});

app.get("/socket", (c) => {
  const headers = new Headers({
    upgrade: "websocket",
    "x-request-id": c.get("requestId"),
  });
  const protocol = c.req.header("sec-websocket-protocol");
  if (protocol) headers.set("sec-websocket-protocol", protocol);
  return c.env.ROOMS.getByName(c.get("roomId")).fetch(
    "https://video-room.internal/socket",
    { headers },
  );
});

app.post("/join", jsonRequest(joinRequestSchema, withDisplayHint), async (c) =>
  rpcResponse(
    await c.get("room").join(c.get("rpc"), c.req.valid("json")),
    c.get("requestId"),
    201,
  ),
);
app.post(
  "/reconnect",
  jsonRequest(reconnectRequestSchema, withDisplayHint),
  async (c) =>
    rpcResponse(
      await c.get("room").reconnect(c.get("rpc"), c.req.valid("json")),
      c.get("requestId"),
    ),
);
app.post("/publish", jsonRequest(publishRequestSchema), async (c) =>
  rpcResponse(
    await c.get("room").publish(c.get("rpc"), c.req.valid("json")),
    c.get("requestId"),
  ),
);
app.post("/subscribe", jsonRequest(subscribeRequestSchema), async (c) =>
  rpcResponse(
    await c.get("room").subscribe(c.get("rpc"), c.req.valid("json")),
    c.get("requestId"),
  ),
);
app.post("/renegotiate", jsonRequest(renegotiateRequestSchema), async (c) =>
  rpcResponse(
    await c.get("room").renegotiate(c.get("rpc"), c.req.valid("json")),
    c.get("requestId"),
  ),
);
app.get("/snapshot", async (c) =>
  rpcResponse(
    await c.get("room").getSnapshot(c.get("rpc")),
    c.get("requestId"),
  ),
);
app.post("/heartbeat", async (c) =>
  rpcResponse(await c.get("room").heartbeat(c.get("rpc")), c.get("requestId")),
);
app.post("/socket-ticket", async (c) =>
  rpcResponse(
    await c.get("room").issueSocketTicket(c.get("rpc")),
    c.get("requestId"),
  ),
);
app.post("/leave", async (c) =>
  rpcResponse(await c.get("room").leave(c.get("rpc")), c.get("requestId")),
);
app.post("/terminate", async (c) =>
  rpcResponse(await c.get("room").terminate(c.get("rpc")), c.get("requestId")),
);
app.all(roomRoute, () => {
  throw routeNotFound();
});
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) =>
  errorResponse(error, c.get("requestId") ?? crypto.randomUUID()),
);

export default app;

function jsonRequest<S extends z.ZodType<Record<string, unknown>>>(
  schema: S,
  normalize: (value: unknown, c: Context<RoomEnv>) => unknown = (value) =>
    value,
) {
  return createMiddleware<RoomEnv, string, { out: { json: z.output<S> } }>(
    async (c, next) => {
      let value: unknown;
      try {
        // Decode once, including clients that omit Content-Type. The standard
        // JSON validator skips those bodies; this API has always accepted them.
        value = await c.req.json();
      } catch {
        throw new RequestError(
          400,
          "json_invalid",
          "Send a valid JSON request.",
        );
      }
      const parsed = schema.safeParse(normalize(value, c));
      if (!parsed.success) throw invalidRequest(parsed.error, c.req.path);
      c.req.addValidatedData("json", parsed.data);
      await next();
    },
  );
}

function withDisplayHint(value: unknown, c: Context<RoomEnv>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const body = value as Record<string, unknown>;
  return {
    ...body,
    displayName: body.displayName ?? c.get("rpc").principal.displayHint,
  };
}

function invalidRequest(error: z.ZodError, path: string): RequestError {
  const issue = error.issues[0];
  const field = issue?.path[0];
  if (field === undefined)
    return new RequestError(400, "body_invalid", "Send a JSON object.");
  if (field === "generation")
    return new RequestError(
      400,
      "generation_invalid",
      "A positive media generation is required.",
    );
  if (field === "sessionDescription") {
    return path.endsWith("/publish")
      ? new RequestError(
          400,
          "offer_invalid",
          "Publishing requires a valid SDP offer.",
        )
      : new RequestError(
          400,
          "answer_invalid",
          "Renegotiation requires a valid SDP answer.",
        );
  }
  if (field === "tracks" && issue?.path[2] !== "mid") {
    return new RequestError(
      400,
      "publish_tracks_invalid",
      "Publish one audio track, one video track, or both.",
    );
  }
  if (field === "trackKeys" && issue?.path.length === 1) {
    return new RequestError(400, "body_invalid", "trackKeys must be an array.");
  }
  return new RequestError(
    400,
    "input_invalid",
    "A request field is missing or invalid.",
  );
}

function bodyTooLarge(): RequestError {
  return new RequestError(
    413,
    "body_too_large",
    "The request body is too large.",
  );
}

function routeNotFound(): RequestError {
  return new RequestError(
    404,
    "route_not_found",
    "The room operation does not exist.",
  );
}
