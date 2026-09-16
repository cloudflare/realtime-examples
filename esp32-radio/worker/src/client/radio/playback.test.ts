import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptMetadata, matchesPlayback, playbackView } from './playback.ts';
import { initialState } from './session-state.ts';

const first = { title: 'First', artist: '', durationMs: 2000 };
const current = { revision: 0xffff_ffff, trackIndex: 0, trackCount: 2, track: first };

test('metadata wraps revisions and ignores delayed or conflicting same-revision snapshots', () => {
  const next = { ...current, revision: 0, trackIndex: 1, track: null };
  assert.equal(acceptMetadata(current, next), next);
  assert.equal(acceptMetadata(next, current), next);
  assert.equal(acceptMetadata(next, { ...next, track: first }), next);
  assert.equal(acceptMetadata(undefined, current), current);
  assert.equal(matchesPlayback(current.revision, next), false);
  assert.equal(matchesPlayback(0, next), true);
  assert.equal(matchesPlayback(undefined, next), true);
});

test('unknown current metadata never falls back to an older HTTP song', () => {
  const state = initialState();
  state.room.track = first;
  assert.equal(playbackView(state).track, first);
  state.nowPlaying = { ...current, track: null };
  assert.equal(playbackView(state).track, undefined);
  assert.equal(playbackView(state).duration, 0);
  state.nowPlaying = current;
  state.paused = true;
  assert.deepEqual(playbackView(state), {
    track: first,
    trackCount: 2,
    position: 0,
    duration: 2000,
    paused: true,
  });
});
