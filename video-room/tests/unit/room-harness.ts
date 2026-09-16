import type { SessionDescription } from "../../src/shared/protocol";
import {
  type SfuClient,
  type SfuResponse,
} from "../../src/server/realtime";
import {
  RoomCoordinator,
  emptyRoom,
  type PersistedRoom,
} from "../../src/server/room";

export const OFFER: SessionDescription = { sdp: "offer-sdp", type: "offer" };
export const ANSWER: SessionDescription = { sdp: "answer-sdp", type: "answer" };
export const ALICE_MEMBER_TOKEN = "a".repeat(43);
export const BOB_MEMBER_TOKEN = "b".repeat(43);
export const CHARLIE_MEMBER_TOKEN = "c".repeat(43);

export class FakeSfu implements SfuClient {
  readonly addTrackBarriers: Promise<void>[] = [];
  readonly addResponses: SfuResponse[] = [];
  readonly added: Array<{
    body: Record<string, unknown>;
    sessionId: string;
  }> = [];
  readonly closeErrors: unknown[] = [];
  readonly closeResponses: SfuResponse[] = [];
  readonly closeTrackBarriers: Promise<void>[] = [];
  readonly closed: Array<{ mids: string[]; sessionId: string }> = [];
  readonly createSessionBarriers: Promise<void>[] = [];
  readonly events: string[] = [];
  readonly renegotiateBarriers: Promise<void>[] = [];
  readonly renegotiated: string[] = [];
  sessions = 0;

  async createSession(): Promise<string> {
    this.sessions += 1;
    const sessionId = `session-${this.sessions}`;
    this.events.push(`create:${sessionId}`);
    await this.createSessionBarriers.shift();
    return sessionId;
  }

  async addTracks(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<SfuResponse> {
    this.added.push({ body, sessionId });
    await this.addTrackBarriers.shift();
    const configured = this.addResponses.shift();
    if (configured) return configured;
    const tracks = body.tracks as Array<{
      mid?: string;
      sessionId?: string;
      trackName: string;
    }>;
    if (body.sessionDescription) {
      return {
        requiresImmediateRenegotiation: false,
        sessionDescription: ANSWER,
        tracks: tracks.map((track, index) => ({
          mid: track.mid ?? String(index),
          trackName: track.trackName,
        })),
      };
    }
    return {
      requiresImmediateRenegotiation: true,
      sessionDescription: OFFER,
      tracks: tracks.map((track, index) => ({
        mid: `remote-${index}`,
        sessionId: track.sessionId,
        trackName: track.trackName,
      })),
    };
  }

  async closeTracks(
    sessionId: string,
    mids: string[],
  ): Promise<SfuResponse> {
    this.closed.push({ mids, sessionId });
    this.events.push(`close:${sessionId}`);
    await this.closeTrackBarriers.shift();
    const error = this.closeErrors.shift();
    if (error) throw error;
    return this.closeResponses.shift() ?? {
      requiresImmediateRenegotiation: false,
      tracks: mids.map((mid) => ({ mid })),
    };
  }

  async renegotiate(sessionId: string): Promise<void> {
    this.events.push(`renegotiate-start:${sessionId}`);
    await this.renegotiateBarriers.shift();
    this.renegotiated.push(sessionId);
    this.events.push(`renegotiate-settled:${sessionId}`);
  }
}

export function harness(
  options: {
    closeParticipantSockets?: (participantId: string) => void;
    notifyRevision?: (revision: number) => void;
    now?: () => number;
    room?: PersistedRoom;
    sfu?: FakeSfu;
  } = {},
) {
  const sfu = options.sfu ?? new FakeSfu();
  const room = options.room ?? emptyRoom("demo-room");
  const persistBarriers: Promise<void>[] = [];
  const writes: PersistedRoom[] = [];
  let id = 0;
  let token = 0;
  const coordinator = new RoomCoordinator(room, {
    closeParticipantSockets: options.closeParticipantSockets,
    now: options.now,
    notifyRevision: options.notifyRevision,
    persist: async (state) => {
      writes.push(structuredClone(state));
      await persistBarriers.shift();
    },
    randomId: () => `participant${++id}`,
    randomToken: () => `token-${++token}-abcdefghijklmnopqrstuvwxyz`,
    sfu,
    staleMs: 45_000,
  });
  return { coordinator, persistBarriers, room, sfu, writes };
}

export const alice = { displayHint: "alice", subject: "user:alice" };
export const bob = { displayHint: "bob", subject: "user:bob" };
export const charlie = { displayHint: "charlie", subject: "user:charlie" };

export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}
