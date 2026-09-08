import {
  ROOM_SOCKET_PROTOCOL,
  ROOM_SOCKET_TICKET_PREFIX,
  type RoomChangedNotification,
} from "../shared/protocol";
import type { RoomApi } from "./api";

type NotificationSocket = {
  close(code?: number, reason?: string): void;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onopen: ((event: Event) => void) | null;
};

type SocketFactory = (
  url: string,
  protocols: string[],
) => NotificationSocket;
type ScheduleTimeout = (
  callback: () => void,
  milliseconds: number,
) => unknown;
type CancelTimeout = (handle: unknown) => void;

type NotificationDependencies = {
  cancelTimeout?: CancelTimeout;
  createSocket?: SocketFactory;
  random?: () => number;
  scheduleTimeout?: ScheduleTimeout;
};

export class RoomNotifications {
  private active = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer?: unknown;
  private socket?: NotificationSocket;

  private readonly cancelTimeout: CancelTimeout;
  private readonly createSocket: SocketFactory;
  private readonly random: () => number;
  private readonly scheduleTimeout: ScheduleTimeout;

  constructor(
    private readonly api: Pick<
      RoomApi,
      "issueSocketTicket" | "notificationSocketUrl"
    >,
    private readonly resync: () => Promise<void> | void,
    dependencies: NotificationDependencies = {},
  ) {
    this.cancelTimeout =
      dependencies.cancelTimeout ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.createSocket =
      dependencies.createSocket ??
      ((url, protocols) => new WebSocket(url, protocols));
    this.random = dependencies.random ?? Math.random;
    this.scheduleTimeout =
      dependencies.scheduleTimeout ??
      ((callback, milliseconds) => setTimeout(callback, milliseconds));
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.generation += 1;
    void this.connect(this.generation);
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
    if (this.reconnectTimer !== undefined) {
      this.cancelTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "Notification client stopped.");
  }

  private async connect(generation: number): Promise<void> {
    try {
      const { ticket } = await this.api.issueSocketTicket();
      if (!this.active || generation !== this.generation) return;
      const socket = this.createSocket(this.api.notificationSocketUrl(), [
        ROOM_SOCKET_PROTOCOL,
        `${ROOM_SOCKET_TICKET_PREFIX}${ticket}`,
      ]);
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket || !this.active) return;
        this.reconnectAttempt = 0;
        void this.resync();
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket || !this.active) return;
        if (parseRoomChangedNotification(event.data)) void this.resync();
      };
      socket.onerror = () => {
        if (this.socket === socket) socket.close();
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        void this.resync();
        this.scheduleReconnect(generation);
      };
    } catch {
      this.scheduleReconnect(generation);
    }
  }

  private scheduleReconnect(generation: number): void {
    if (
      !this.active ||
      generation !== this.generation ||
      this.reconnectTimer !== undefined
    ) {
      return;
    }
    const base = Math.min(
      1_000 * 2 ** Math.min(this.reconnectAttempt, 4),
      15_000,
    );
    this.reconnectAttempt += 1;
    const delay = base + Math.floor(this.random() * 250);
    this.reconnectTimer = this.scheduleTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(generation);
    }, delay);
  }
}

export function parseRoomChangedNotification(
  value: unknown,
): RoomChangedNotification | undefined {
  if (typeof value !== "string" || value.length > 256) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.type !== "room-changed" ||
      !Number.isSafeInteger(parsed.revision) ||
      (parsed.revision as number) < 0
    ) {
      return undefined;
    }
    return {
      revision: parsed.revision as number,
      type: "room-changed",
    };
  } catch {
    return undefined;
  }
}
