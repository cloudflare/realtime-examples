import type { DeviceStart } from '@/shared/contracts/signaling.ts';
import { newerRevision, sameNowPlaying } from '@/shared/contracts/track.ts';
import type { NowPlaying, Track } from '@/shared/contracts/track.ts';
import type { Publisher } from './room-state.ts';
import { demand } from './rpc.ts';

function sameTrack(a: Track | null | undefined, b: Track | null | undefined): boolean {
  return a?.title === b?.title && a?.artist === b?.artist && a?.durationMs === b?.durationMs;
}

export function startupMetadata(input: DeviceStart) {
  if (input.nowPlaying && input.track !== undefined) {
    demand(
      sameTrack(input.track, input.nowPlaying.track),
      400,
      'Initial song metadata must agree.',
    );
  }
  return {
    track: (input.nowPlaying ? input.nowPlaying.track : input.track) ?? undefined,
    nowPlaying: input.nowPlaying,
  };
}

export function checkStartupMetadata(
  existing: Publisher,
  input: ReturnType<typeof startupMetadata>,
): void {
  const initialTrack = existing.initialNowPlaying
    ? existing.initialNowPlaying.track
    : existing.track;
  demand(
    sameTrack(initialTrack, input.track),
    409,
    'Startup track information cannot change within a device boot.',
  );
  demand(
    existing.initialNowPlaying
      ? !!input.nowPlaying && sameNowPlaying(existing.initialNowPlaying, input.nowPlaying)
      : !input.nowPlaying,
    409,
    'Startup playlist information cannot change within a device boot.',
  );
}

/** Reject conflicts, ignore delayed revisions, and retain the accepted immutable value. */
export function heartbeatMetadata(previous: NowPlaying | undefined, next: NowPlaying): NowPlaying {
  demand(
    !previous || previous.trackCount === next.trackCount,
    409,
    'Playlist size cannot change within a device boot.',
  );
  if (previous?.revision === next.revision) {
    demand(sameNowPlaying(previous, next), 409, 'A playback revision cannot describe two songs.');
  }
  return !previous || newerRevision(next.revision, previous.revision) ? next : previous;
}
