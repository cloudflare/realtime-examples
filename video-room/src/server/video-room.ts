import { DurableObject } from "cloudflare:workers";

import {
  ROOM_SOCKET_PROTOCOL,
  type ApiErrorBody,
  type JoinResponse,
  type PublishResponse,
  type RoomSnapshot,
  type SocketTicketResponse,
  type SubscriptionResponse,
} from "../shared/protocol";
import {
  RequestError,
  type AuthenticatedPrincipal,
} from "./auth";
import {
  broadcastRoomChanged,
  closeParticipantSockets,
  restoreSocketAttachment,
  socketAttachment,
  socketTicketFromProtocols,
} from "./notifications";
import {
  RealtimeSfuClient,
  SfuRequestError,
  type RealtimeEnv,
} from "./realtime";
import {
  RoomCoordinator,
  emptyRoom,
  type PersistedRoom,
} from "./room";
import { SessionQueueError } from "./session-mutation-queue";

type Env = RealtimeEnv & {
  ROOM_STALE_SECONDS?: string;
};

export type RoomRpcContext = {
  memberToken: string | null;
  principal: AuthenticatedPrincipal;
  requestId: string;
};

export type RoomRpcError = {
  code: string;
  message: string;
  retryable: boolean;
  status: number;
};

export type RoomRpcResult<T> =
  | { type: "error"; error: RoomRpcError }
  | { type: "ok"; value: T };

export class VideoRoom extends DurableObject<Env> {
  private coordinator?: RoomCoordinator;
  private room?: PersistedRoom;
  private readonly roomId: string;
  private readonly ready: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    const roomId = state.id.name;
    if (!roomId) {
      throw new Error("VideoRoom must be addressed with a named Durable Object ID.");
    }
    this.roomId = roomId;
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.room = await this.ctx.storage.get<PersistedRoom>("room");
    });
  }

  join(
    context: RoomRpcContext,
    input: unknown,
  ): Promise<RoomRpcResult<JoinResponse>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.join(context.principal, input),
    );
  }

  reconnect(
    context: RoomRpcContext,
    input: unknown,
  ): Promise<RoomRpcResult<JoinResponse>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.reconnect(
        context.principal,
        context.memberToken,
        input,
      ),
    );
  }

  heartbeat(
    context: RoomRpcContext,
  ): Promise<RoomRpcResult<RoomSnapshot>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.heartbeat(context.principal, context.memberToken),
    );
  }

  getSnapshot(
    context: RoomRpcContext,
  ): Promise<RoomRpcResult<RoomSnapshot>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.getSnapshot(context.principal, context.memberToken),
    );
  }

  issueSocketTicket(
    context: RoomRpcContext,
  ): Promise<RoomRpcResult<SocketTicketResponse>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.issueSocketTicket(
        context.principal,
        context.memberToken,
      ),
    );
  }

  publish(
    context: RoomRpcContext,
    input: unknown,
  ): Promise<RoomRpcResult<PublishResponse>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.publish(context.principal, context.memberToken, input),
    );
  }

  subscribe(
    context: RoomRpcContext,
    input: unknown,
  ): Promise<RoomRpcResult<SubscriptionResponse>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.subscribe(context.principal, context.memberToken, input),
    );
  }

  renegotiate(
    context: RoomRpcContext,
    input: unknown,
  ): Promise<RoomRpcResult<{ ok: true }>> {
    return this.#runRpc(context, async (coordinator) => {
      await coordinator.renegotiate(
        context.principal,
        context.memberToken,
        input,
      );
      return { ok: true };
    });
  }

  leave(context: RoomRpcContext): Promise<RoomRpcResult<RoomSnapshot>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.leave(context.principal, context.memberToken),
    );
  }

  terminate(context: RoomRpcContext): Promise<RoomRpcResult<RoomSnapshot>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.terminate(context.principal, context.memberToken),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      if (
        request.method !== "GET" ||
        new URL(request.url).pathname !== "/socket"
      ) {
        throw new RequestError(
          404,
          "route_not_found",
          "The room operation does not exist.",
        );
      }
      await this.ready;
      return await this.#acceptNotificationSocket(
        request,
        this.#getCoordinator(),
      );
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }

  async alarm(): Promise<void> {
    await this.ready;
    if (!this.room) return;
    const coordinator = this.#getCoordinator();
    let alarmError: unknown;
    let alarmFailed = false;
    let cleared = false;
    try {
      const lease = await coordinator.expireStale();
      if (lease) {
        cleared = await coordinator.deleteWithLease(lease, () =>
          this.ctx.storage.deleteAll(),
        );
      }
    } catch (error) {
      alarmError = error;
      alarmFailed = true;
    }

    if (!cleared) {
      try {
        await this.#scheduleAlarm(alarmFailed ? 5_000 : 0);
      } catch (scheduleError) {
        if (!alarmFailed) throw scheduleError;
      }
    }
    if (alarmFailed) throw alarmError;
  }

  webSocketMessage(socket: WebSocket): void {
    safelyRestoreSocketAttachment(socket);
    socket.close(1008, "Notification socket is server-to-client only.");
  }

  webSocketClose(socket: WebSocket): void {
    safelyRestoreSocketAttachment(socket);
  }

  webSocketError(socket: WebSocket): void {
    safelyRestoreSocketAttachment(socket);
    socket.close(1011, "Notification socket error.");
  }

  #getCoordinator(): RoomCoordinator {
    if (!this.room) this.room = emptyRoom(this.roomId);
    if (this.room.roomId !== this.roomId) {
      throw new Error("VideoRoom storage does not match its Durable Object name.");
    }
    if (!this.coordinator) {
      this.coordinator = new RoomCoordinator(this.room, {
        closeParticipantSockets: (participantId) => {
          closeParticipantSockets(
            this.ctx.getWebSockets(),
            participantId,
          );
        },
        persist: async (room) => {
          this.room = room;
          await this.ctx.storage.put("room", room);
        },
        notifyRevision: (revision) => {
          broadcastRoomChanged(this.ctx.getWebSockets(), revision);
        },
        sfu: new RealtimeSfuClient(this.env),
        staleMs: staleMilliseconds(this.env.ROOM_STALE_SECONDS),
      });
    }
    return this.coordinator;
  }

  async #acceptNotificationSocket(
    request: Request,
    coordinator: RoomCoordinator,
  ): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new RequestError(
        426,
        "websocket_upgrade_required",
        "This endpoint requires a WebSocket upgrade.",
      );
    }
    const ticket = socketTicketFromProtocols(
      request.headers.get("sec-websocket-protocol"),
    );
    if (!ticket) {
      throw new RequestError(
        401,
        "socket_ticket_required",
        "Request a notification ticket before opening the socket.",
      );
    }
    const attachment = await coordinator.consumeSocketTicket(ticket);
    closeParticipantSockets(
      this.ctx.getWebSockets(),
      attachment.participantId,
    );
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(socketAttachment(attachment.participantId));
    return new Response(null, {
      headers: { "sec-websocket-protocol": ROOM_SOCKET_PROTOCOL },
      status: 101,
      webSocket: client,
    });
  }

  async #scheduleAlarm(minimumDelayMs = 0): Promise<void> {
    if (!this.coordinator) return;
    await this.ctx.storage.setAlarm(
      Math.max(
        this.coordinator.nextAlarmAt(),
        Date.now() + minimumDelayMs,
      ),
    );
  }

  async #runRpc<T>(
    context: RoomRpcContext,
    operation: (coordinator: RoomCoordinator) => Promise<T>,
  ): Promise<RoomRpcResult<T>> {
    try {
      await this.ready;
      const value = await operation(this.#getCoordinator());
      await this.#scheduleAlarm();
      return { type: "ok", value };
    } catch (error) {
      const expected = expectedRoomError(error, context.requestId);
      if (expected) return { type: "error", error: expected };
      throw error;
    }
  }
}

function staleMilliseconds(value: string | undefined): number {
  const seconds = Number(value ?? 45);
  if (!Number.isFinite(seconds) || seconds < 20 || seconds > 300) {
    return 45_000;
  }
  return seconds * 1000;
}

function safelyRestoreSocketAttachment(socket: WebSocket): void {
  try {
    restoreSocketAttachment(socket.deserializeAttachment());
  } catch {
    // Socket lifecycle errors never alter room presence.
  }
}

function json(
  body: ApiErrorBody | unknown,
  status = 200,
  requestId?: string,
): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
    status,
  });
}

export function errorResponse(
  error: unknown,
  requestId: string,
): Response {
  const expected = expectedRoomError(error, requestId);
  if (expected) {
    return json(
      {
        error: {
          code: expected.code,
          message: expected.message,
          requestId,
          retryable: expected.retryable,
        },
      } satisfies ApiErrorBody,
      expected.status,
      requestId,
    );
  }
  console.error("video-room request failed", { requestId });
  return json(
    {
      error: {
        code: "internal_error",
        message: "The room operation failed. Retry with the request ID.",
        requestId,
        retryable: true,
      },
    } satisfies ApiErrorBody,
    500,
    requestId,
  );
}

function expectedRoomError(
  error: unknown,
  requestId: string,
): RoomRpcError | undefined {
  if (error instanceof RequestError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    };
  }
  if (error instanceof SessionQueueError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: 409,
    };
  }
  if (error instanceof SfuRequestError) {
    console.error("Realtime SFU request failed", {
      code: error.code,
      ...(error.track?.mid ? { mid: error.track.mid } : {}),
      requestId,
      status: error.status,
      ...(error.track?.trackName
        ? { trackName: error.track.trackName }
        : {}),
    });
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    };
  }
  return undefined;
}
