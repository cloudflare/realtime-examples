import {
  assertSameOrigin,
  authenticateRequest,
  RequestError,
  type AuthEnv,
} from "./server/auth";
import type { RealtimeEnv } from "./server/realtime";
import {
  errorResponse,
  type RoomRpcContext,
  type RoomRpcResult,
  VideoRoom,
} from "./server/video-room";
import {
  API_HEADER_MEMBER_TOKEN,
  type ApiErrorBody,
} from "./shared/protocol";

export { VideoRoom };

type WorkerEnv = Env & AuthEnv & RealtimeEnv;

const ROOM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const API_ROUTE = /^\/api\/rooms\/([^/]+)\/([^/]+)$/;
const MAX_BODY_BYTES = 1_100_000;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const match = API_ROUTE.exec(url.pathname);
    if (!match) return env.ASSETS.fetch(request);

    const requestId = crypto.randomUUID();
    try {
      const roomId = decodeURIComponent(match[1] ?? "");
      if (!ROOM_ID.test(roomId)) {
        throw new RequestError(
          400,
          "room_id_invalid",
          "Room names use lowercase letters, numbers, and hyphens.",
        );
      }
      const action = match[2] ?? "";

      if (request.method === "GET" && action === "socket") {
        assertSameOrigin(request);
        return await env.ROOMS.getByName(roomId).fetch(
          "https://video-room.internal/socket",
          { headers: socketHeaders(request) },
        );
      }

      if (request.method !== "GET") assertSameOrigin(request);
      const principal = await authenticateRequest(request, env);
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await readBody(request);
      const context: RoomRpcContext = {
        memberToken: request.headers.get(API_HEADER_MEMBER_TOKEN),
        principal,
        requestId,
      };
      const stub = env.ROOMS.getByName(roomId);

      switch (`${request.method} ${action}`) {
        case "POST join":
          return rpcResponse(
            await stub.join(context, parseJson(body)),
            requestId,
            201,
          );
        case "POST reconnect":
          return rpcResponse(
            await stub.reconnect(context, parseJson(body)),
            requestId,
          );
        case "POST heartbeat":
          return rpcResponse(await stub.heartbeat(context), requestId);
        case "GET snapshot":
          return rpcResponse(await stub.getSnapshot(context), requestId);
        case "POST socket-ticket":
          return rpcResponse(await stub.issueSocketTicket(context), requestId);
        case "POST publish":
          return rpcResponse(
            await stub.publish(context, parseJson(body)),
            requestId,
          );
        case "POST subscribe":
          return rpcResponse(
            await stub.subscribe(context, parseJson(body)),
            requestId,
          );
        case "POST renegotiate":
          return rpcResponse(
            await stub.renegotiate(context, parseJson(body)),
            requestId,
          );
        case "POST leave":
          return rpcResponse(await stub.leave(context), requestId);
        case "POST terminate":
          return rpcResponse(await stub.terminate(context), requestId);
        default:
          throw new RequestError(
            404,
            "route_not_found",
            "The room operation does not exist.",
          );
      }
    } catch (error) {
      return errorResponse(error, requestId);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

function socketHeaders(request: Request): Headers {
  const headers = new Headers({ upgrade: "websocket" });
  const protocol = request.headers.get("sec-websocket-protocol");
  if (protocol) headers.set("sec-websocket-protocol", protocol);
  return headers;
}

async function readBody(request: Request): Promise<ArrayBuffer> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw new RequestError(
      413,
      "body_too_large",
      "The request body is too large.",
    );
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new RequestError(
      413,
      "body_too_large",
      "The request body is too large.",
    );
  }
  return body;
}

function parseJson(body: ArrayBuffer | undefined): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new RequestError(400, "json_invalid", "Send a valid JSON request.");
  }
}

function rpcResponse<T>(
  result: RoomRpcResult<T>,
  requestId: string,
  status = 200,
): Response {
  if (result.type === "error") {
    return json(
      {
        error: {
          code: result.error.code,
          message: result.error.message,
          requestId,
          retryable: result.error.retryable,
        },
      } satisfies ApiErrorBody,
      result.error.status,
      requestId,
    );
  }
  return json(result.value, status, requestId);
}

function json(body: unknown, status: number, requestId: string): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
    status,
  });
}
