import assert from "node:assert/strict";
import test from "node:test";

import {
  ROOM_SOCKET_PROTOCOL,
  ROOM_SOCKET_TICKET_PREFIX,
} from "../../src/shared/protocol";
import {
  startRoomNotifications,
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
  const stop = startRoomNotifications(
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

  await flush();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]?.url.includes(TICKET_A), false);
  assert.deepEqual(sockets[0]?.protocols, [
    ROOM_SOCKET_PROTOCOL,
    `${ROOM_SOCKET_TICKET_PREFIX}${TICKET_A}`,
  ]);

  sockets[0]?.emitOpen();
  assert.equal(resyncs, 1);
  sockets[0]?.emitMessage("x".repeat(257));
  sockets[0]?.emitMessage("not JSON");
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
  sockets[0]?.emitOpen();
  sockets[0]?.emitMessage(JSON.stringify({ type: "room-changed", revision: 9 }));
  sockets[0]?.emitClose();
  assert.equal(resyncs, 4);
  assert.equal(timers.length, 1);
  stop();
  stop();
  sockets[1]?.emitOpen();
  sockets[1]?.emitClose();
  assert.equal(resyncs, 4);
  assert.equal(sockets[1]?.closes, 1);
  timers[0]?.callback();
  await flush();
  assert.equal(issueCount, 2);
});

test("stopping notifications aborts the pending ticket and ignores its late result", async () => {
  let releaseTicket!: (ticket: { ticket: string; expiresAt: number }) => void;
  let requestSignal: AbortSignal | undefined;
  const pendingTicket = new Promise<{ ticket: string; expiresAt: number }>(
    (resolve) => { releaseTicket = resolve; },
  );
  let connections = 0;
  let timers = 0;
  const stop = startRoomNotifications({
    issueSocketTicket(signal) {
      requestSignal = signal;
      return pendingTicket;
    },
    notificationSocketUrl: () => "wss://room.example/api/rooms/demo/socket",
  }, () => assert.fail("A stopped notification lifetime must not resync."), {
    createSocket: (url, protocols) => {
      connections += 1;
      return new FakeClientSocket(url, protocols);
    },
    scheduleTimeout: () => { timers += 1; },
  });
  stop();
  assert.equal(requestSignal?.aborted, true);
  releaseTicket({ ticket: TICKET_A, expiresAt: Date.now() + 30_000 });
  await flush();
  assert.equal(connections, 0);
  assert.equal(timers, 0);
});

class FakeClientSocket {
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  closes = 0;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  close(): void { this.closes += 1; }

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
