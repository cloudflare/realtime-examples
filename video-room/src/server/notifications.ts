import { z } from "zod";

import {
  ROOM_SOCKET_PROTOCOL,
  ROOM_SOCKET_TICKET_PREFIX,
  type RoomChangedNotification,
} from "../shared/protocol";

const PARTICIPANT_ID = /^p_[a-zA-Z0-9]{1,32}$/;
export const SOCKET_TICKET = /^[a-zA-Z0-9_-]{32,128}$/;

const socketAttachmentSchema = z.strictObject({
  participantId: z.string().regex(PARTICIPANT_ID),
});
export type SocketAttachment = z.infer<typeof socketAttachmentSchema>;

type HibernatingSocket = {
  close(code?: number, reason?: string): void;
  deserializeAttachment(): unknown;
  send(message: string): void;
};

export function socketTicketFromProtocols(
  header: string | null,
): string | undefined {
  if (!header || header.length > 512) return undefined;
  const protocols = header
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!protocols.includes(ROOM_SOCKET_PROTOCOL)) return undefined;
  const tickets = protocols
    .filter((value) => value.startsWith(ROOM_SOCKET_TICKET_PREFIX))
    .map((value) => value.slice(ROOM_SOCKET_TICKET_PREFIX.length));
  return tickets.length === 1 && SOCKET_TICKET.test(tickets[0]!)
    ? tickets[0]
    : undefined;
}

export function socketAttachment(participantId: string): SocketAttachment {
  const parsed = socketAttachmentSchema.safeParse({ participantId });
  if (!parsed.success) throw new Error("Invalid participant attachment.");
  return parsed.data;
}

export function restoreSocketAttachment(
  value: unknown,
): SocketAttachment | undefined {
  const parsed = socketAttachmentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function broadcastRoomChanged(
  sockets: HibernatingSocket[],
  revision: number,
): number {
  if (!Number.isSafeInteger(revision) || revision < 0) return 0;
  const message = JSON.stringify({
    revision,
    type: "room-changed",
  } satisfies RoomChangedNotification);
  let sent = 0;
  for (const socket of sockets) {
    try {
      if (!restoreSocketAttachment(socket.deserializeAttachment())) {
        socket.close(1008, "Invalid notification attachment.");
        continue;
      }
      socket.send(message);
      sent += 1;
    } catch {
      // Closing sockets are omitted by later getWebSockets() calls.
    }
  }
  return sent;
}

export function closeParticipantSockets(
  sockets: HibernatingSocket[],
  participantId: string,
): number {
  let closed = 0;
  for (const socket of sockets) {
    try {
      const attachment = restoreSocketAttachment(
        socket.deserializeAttachment(),
      );
      if (attachment?.participantId !== participantId) continue;
      socket.close(1000, "Replaced by a newer notification socket.");
      closed += 1;
    } catch {
      // A closing socket must not block the replacement connection.
    }
  }
  return closed;
}
