import assert from "node:assert/strict";
import test from "node:test";

import {
  ROOM_SOCKET_PROTOCOL,
  ROOM_SOCKET_TICKET_PREFIX,
} from "../../src/shared/protocol";
import {
  SAFETY_POLL_INTERVAL_MS,
  SafetyPoller,
} from "../../src/client/safety-poller";
import {
  RoomNotifications,
  parseRoomChangedNotification,
} from "../../src/client/notifications";
import {
  restoreSocketAttachment,
  socketAttachment,
  socketTicketFromProtocols,
} from "../../src/server/notifications";

const TICKET_A = "a".repeat(43);
const TICKET_B = "b".repeat(43);

test("ticket protocol parsing never requires a URL credential", () => {
  assert.equal(
    socketTicketFromProtocols(
      `${ROOM_SOCKET_PROTOCOL}, ${ROOM_SOCKET_TICKET_PREFIX}${TICKET_A}`,
    ),
    TICKET_A,
  );
  assert.equal(
    socketTicketFromProtocols(`${ROOM_SOCKET_TICKET_PREFIX}${TICKET_A}`),
    undefined,
  );
  assert.equal(
    socketTicketFromProtocols(
      `${ROOM_SOCKET_PROTOCOL}, ${ROOM_SOCKET_TICKET_PREFIX}${TICKET_A}, ${ROOM_SOCKET_TICKET_PREFIX}${TICKET_B}`,
    ),
    undefined,
  );

  assert.deepEqual(
    restoreSocketAttachment(
      structuredClone(socketAttachment("p_participant1")),
    ),
    { participantId: "p_participant1" },
  );
  assert.equal(
    restoreSocketAttachment({
      memberToken: "must-not-be-attached",
      participantId: "p_participant1",
    }),
    undefined,
  );
});

test("notification socket reconnects with backoff and resyncs on open/message", async () => {
  const tickets = [TICKET_A, TICKET_B];
  const sockets: FakeClientSocket[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let issueCount = 0;
  let resyncs = 0;
  const notifications = new RoomNotifications(
    {
      issueSocketTicket: async () => ({
        expiresAt: Date.now() + 30_000,
        ticket: tickets[issueCount++]!,
      }),
      notificationSocketUrl: () =>
        "wss://room.example/api/rooms/demo/socket",
    },
    () => {
      resyncs += 1;
    },
    {
      createSocket: (url, protocols) => {
        const socket = new FakeClientSocket(url, protocols);
        sockets.push(socket);
        return socket;
      },
      random: () => 0,
      scheduleTimeout: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
    },
  );

  notifications.start();
  await flush();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]?.url.includes(TICKET_A), false);
  assert.deepEqual(sockets[0]?.protocols, [
    ROOM_SOCKET_PROTOCOL,
    `${ROOM_SOCKET_TICKET_PREFIX}${TICKET_A}`,
  ]);

  sockets[0]?.emitOpen();
  assert.equal(resyncs, 1);
  sockets[0]?.emitMessage(JSON.stringify({ type: "ignored", revision: 1 }));
  assert.equal(resyncs, 1);
  sockets[0]?.emitMessage(
    JSON.stringify({ type: "room-changed", revision: 2 }),
  );
  assert.equal(resyncs, 2);

  sockets[0]?.emitClose();
  assert.equal(resyncs, 3);
  assert.equal(timers[0]?.delay, 1_000);
  timers[0]?.callback();
  await flush();
  assert.equal(sockets.length, 2);
  sockets[1]?.emitOpen();
  assert.equal(resyncs, 4);
  notifications.stop();
});

test("periodic safety polling runs every fifteen seconds and can stop", () => {
  let callback: (() => void) | undefined;
  let delay = 0;
  let canceled = false;
  let polls = 0;
  const poller = new SafetyPoller(
    () => {
      polls += 1;
    },
    SAFETY_POLL_INTERVAL_MS,
    (scheduled, milliseconds) => {
      callback = scheduled;
      delay = milliseconds;
      return "timer";
    },
    (handle) => {
      assert.equal(handle, "timer");
      canceled = true;
    },
  );

  poller.start();
  poller.start();
  assert.equal(delay, 15_000);
  callback?.();
  assert.equal(polls, 1);
  poller.stop();
  assert.equal(canceled, true);
});

test("notification parser rejects oversized and malformed messages", () => {
  assert.deepEqual(
    parseRoomChangedNotification(
      JSON.stringify({ type: "room-changed", revision: 3 }),
    ),
    { type: "room-changed", revision: 3 },
  );
  assert.equal(parseRoomChangedNotification("x".repeat(257)), undefined);
  assert.equal(
    parseRoomChangedNotification(
      JSON.stringify({ type: "room-changed", revision: -1 }),
    ),
    undefined,
  );
});

class FakeClientSocket {
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  close(): void {}

  emitClose(): void {
    this.onclose?.({} as CloseEvent);
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitOpen(): void {
    this.onopen?.({} as Event);
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
