import {
  ROOM_SOCKET_PROTOCOL,
  ROOM_SOCKET_TICKET_PREFIX,
  roomChangedNotificationSchema,
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

export function startRoomNotifications(
  api: Pick<RoomApi, "issueSocketTicket" | "notificationSocketUrl">,
  resync: () => Promise<void> | void,
  dependencies: NotificationDependencies = {},
): () => void {
  const controller = new AbortController();
  const cancelTimeout =
    dependencies.cancelTimeout ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const createSocket =
    dependencies.createSocket ??
    ((url, protocols) => new WebSocket(url, protocols));
  const random = dependencies.random ?? Math.random;
  const scheduleTimeout =
    dependencies.scheduleTimeout ??
    ((callback, milliseconds) => setTimeout(callback, milliseconds));
  let reconnectAttempt = 0;
  let reconnectTimer: unknown;
  let socket: NotificationSocket | undefined;

  void connect();

  return () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (reconnectTimer !== undefined) cancelTimeout(reconnectTimer);
    const current = socket;
    socket = undefined;
    current?.close(1000, "Notification client stopped.");
  };

  async function connect(): Promise<void> {
    if (controller.signal.aborted) return;
    try {
      const { ticket } = await api.issueSocketTicket(controller.signal);
      if (controller.signal.aborted) return;
      const connected = createSocket(api.notificationSocketUrl(), [
        ROOM_SOCKET_PROTOCOL,
        `${ROOM_SOCKET_TICKET_PREFIX}${ticket}`,
      ]);
      socket = connected;
      connected.onopen = () => {
        if (socket !== connected || controller.signal.aborted) return;
        reconnectAttempt = 0;
        void resync();
      };
      connected.onmessage = (event) => {
        if (socket !== connected || controller.signal.aborted) return;
        if (parseRoomChangedNotification(event.data)) void resync();
      };
      connected.onerror = () => {
        if (socket === connected) connected.close();
      };
      connected.onclose = () => {
        if (socket !== connected) return;
        socket = undefined;
        void resync();
        scheduleReconnect();
      };
    } catch {
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (controller.signal.aborted || reconnectTimer !== undefined) return;
    const base = Math.min(
      1_000 * 2 ** Math.min(reconnectAttempt, 4),
      15_000,
    );
    reconnectAttempt += 1;
    const delay = base + Math.floor(random() * 250);
    reconnectTimer = scheduleTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  }
}

export function parseRoomChangedNotification(
  value: unknown,
): RoomChangedNotification | undefined {
  if (typeof value !== "string" || value.length > 256) return undefined;
  try {
    const parsed = roomChangedNotificationSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
