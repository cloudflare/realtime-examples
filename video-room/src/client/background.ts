import type { RoomSnapshot } from "../shared/protocol";
import type { RoomApi } from "./api";
import { startRoomNotifications } from "./notifications";

type RoomBackgroundOptions = {
  api: Pick<
    RoomApi,
    "snapshot" | "heartbeat" | "issueSocketTicket" | "notificationSocketUrl"
  >;
  isCurrent(): boolean;
  onError(error: unknown): void;
  onSnapshot(snapshot: RoomSnapshot): Promise<void>;
  onTerminated(): void;
};

type BackgroundDependencies = {
  scheduleInterval?: (callback: () => void, milliseconds: number) => unknown;
  cancelInterval?: (handle: unknown) => void;
  startNotifications?: typeof startRoomNotifications;
};

/** One room lifetime owns notification resync, fallback polling, and heartbeats. */
export function startRoomBackground(
  options: RoomBackgroundOptions,
  dependencies: BackgroundDependencies = {},
): () => void {
  const controller = new AbortController();
  const scheduleInterval = dependencies.scheduleInterval ?? setInterval;
  const cancelInterval =
    dependencies.cancelInterval ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const startNotifications =
    dependencies.startNotifications ?? startRoomNotifications;
  let polling = false;
  let resyncPending = false;
  let heartbeatPending = false;

  const pollTimer = scheduleInterval(() => void poll(), 15_000);
  const heartbeatTimer = scheduleInterval(() => void heartbeat(), 10_000);
  const stopNotifications = startNotifications(options.api, poll);

  return () => {
    if (controller.signal.aborted) return;
    controller.abort(
      new DOMException("Room background work stopped.", "AbortError"),
    );
    cancelInterval(pollTimer);
    cancelInterval(heartbeatTimer);
    stopNotifications();
  };

  function isCurrent(): boolean {
    return !controller.signal.aborted && options.isCurrent();
  }

  function handleError(error: unknown): void {
    if (
      !isCurrent() ||
      (error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      return;
    }
    options.onError(error);
  }

  async function poll(): Promise<void> {
    if (!isCurrent()) return;
    if (polling) {
      resyncPending = true;
      return;
    }
    polling = true;
    try {
      do {
        resyncPending = false;
        const snapshot = await options.api.snapshot(controller.signal);
        if (!isCurrent()) return;
        if (snapshot.terminated) {
          options.onTerminated();
          return;
        }
        await options.onSnapshot(snapshot);
      } while (resyncPending && isCurrent());
    } catch (error) {
      handleError(error);
    } finally {
      polling = false;
      if (resyncPending && isCurrent()) {
        resyncPending = false;
        void poll();
      }
    }
  }

  async function heartbeat(): Promise<void> {
    if (!isCurrent() || heartbeatPending) return;
    heartbeatPending = true;
    try {
      const snapshot = await options.api.heartbeat(controller.signal);
      if (isCurrent() && snapshot.terminated) options.onTerminated();
    } catch (error) {
      handleError(error);
    } finally {
      heartbeatPending = false;
    }
  }
}
