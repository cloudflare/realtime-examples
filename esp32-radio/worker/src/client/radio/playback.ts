import { newerRevision } from '@/shared/contracts/track.ts';
import type { NowPlaying } from '@/shared/contracts/track.ts';
import type { SessionState } from './session-state.ts';

export function acceptMetadata(previous: NowPlaying | undefined, next: NowPlaying): NowPlaying {
  return !previous || newerRevision(next.revision, previous.revision) ? next : previous;
}

/** Packets with a revision must match the current playback revision; legacy packets omit it. */
export function matchesPlayback(revision: number | undefined, current?: NowPlaying): boolean {
  return revision === undefined || revision === current?.revision;
}

export function playbackView(
  state: Pick<SessionState, 'room' | 'nowPlaying' | 'telemetry' | 'paused'>,
) {
  const { nowPlaying, room, telemetry } = state;
  // An explicit unknown track must not fall back to stale HTTP metadata.
  const track = (nowPlaying ? nowPlaying.track : room.track) ?? undefined;
  const currentSample = !nowPlaying || telemetry?.playbackRevision === nowPlaying.revision;
  return {
    track,
    trackCount: nowPlaying?.trackCount ?? 1,
    position: currentSample ? (telemetry?.positionMs ?? 0) : 0,
    duration: track?.durationMs ?? (currentSample ? (telemetry?.durationMs ?? 0) : 0),
    paused: state.paused ?? false,
  };
}
