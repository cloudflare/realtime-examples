import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkStartupMetadata, heartbeatMetadata, startupMetadata } from './publisher-metadata.ts';
import type { Publisher } from './room-state.ts';

const track = { title: 'First', artist: '', durationMs: 2000 };
const nowPlaying = { revision: 0, trackIndex: 0, trackCount: 2, track };
const offer = { type: 'offer' as const, sdp: 'v=0' };
const publisher: Publisher = {
  sessionId: 'test',
  generation: 'test',
  ready: true,
  seen: 0,
  channels: [],
  track,
  nowPlaying,
  initialNowPlaying: nowPlaying,
};

test('startup normalization supports legacy, playlist-only and agreeing dual metadata', () => {
  for (const fields of [{ nowPlaying }, { nowPlaying, track }]) {
    const normalized = startupMetadata({ sessionDescription: offer, ...fields });
    checkStartupMetadata(publisher, normalized);
    assert.equal(normalized.track, track);
  }
  const legacy = { ...publisher, nowPlaying: undefined, initialNowPlaying: undefined };
  checkStartupMetadata(legacy, startupMetadata({ sessionDescription: offer, track }));
  assert.throws(() => startupMetadata({ sessionDescription: offer, nowPlaying, track: null }));
  assert.throws(() =>
    startupMetadata({ sessionDescription: offer, nowPlaying, track: { ...track, title: 'Other' } }),
  );
  assert.equal(
    startupMetadata({ sessionDescription: offer, nowPlaying: { ...nowPlaying, track: null } })
      .track,
    undefined,
  );
});

test('heartbeat accepts wrapping revisions but rejects conflicts and playlist resizing', () => {
  const wrapped = { ...nowPlaying, revision: 0xffff_ffff };
  assert.equal(heartbeatMetadata(wrapped, nowPlaying), nowPlaying);
  assert.equal(heartbeatMetadata(nowPlaying, wrapped), nowPlaying);
  assert.throws(() => heartbeatMetadata(nowPlaying, { ...nowPlaying, trackIndex: 1 }));
  assert.throws(() => heartbeatMetadata(nowPlaying, { ...nowPlaying, revision: 1, trackCount: 3 }));
  const playing = {
    ...publisher,
    track: { ...track, title: 'Second' },
    nowPlaying: { ...nowPlaying, revision: 1 },
  };
  checkStartupMetadata(playing, startupMetadata({ sessionDescription: offer, nowPlaying }));
});
