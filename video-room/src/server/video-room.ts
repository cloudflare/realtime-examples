import { DurableObject } from "cloudflare:workers";

import {
  ROOM_SOCKET_PROTOCOL,
  type RenegotiateRequest,
  type SubscribeRequest,
  type PublishRequest,
  type ReconnectRequest,
  type JoinRequest,
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
  socketAttachment,
  socketTicketFromProtocols,
} from "./notifications";
import {
  RealtimeSfuClient,
  type RealtimeEnv,
} from "./realtime";
import {
  RoomCoordinator,
  emptyRoom,
  type PersistedRoom,
} from "./room";
import { errorResponse, expectedRoomError } from "./http";

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
    input: JoinRequest,
  ): Promise<RoomRpcResult<JoinResponse>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.join(context.principal, input),
    );
  }

  reconnect(
    context: RoomRpcContext,
    input: ReconnectRequest,
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
    input: PublishRequest,
  ): Promise<RoomRpcResult<PublishResponse>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.publish(context.principal, context.memberToken, input),
    );
  }

  subscribe(
    context: RoomRpcContext,
    input: SubscribeRequest,
  ): Promise<RoomRpcResult<SubscriptionResponse>> {
    return this.#runRpc(context, (coordinator) =>
      coordinator.subscribe(context.principal, context.memberToken, input),
    );
  }

  renegotiate(
    context: RoomRpcContext,
    input: RenegotiateRequest,
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
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
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
    socket.close(1008, "Notification socket is server-to-client only.");
  }

  webSocketClose(): void {
    // Socket closure does not change presence; heartbeat expiry owns departure.
  }

  webSocketError(socket: WebSocket): void {
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
