import { describe, expect, it } from 'vitest';
import type { EventBatch, VoiceEvent } from '../../web/src/lib/contracts';
import { EventCursor, PlaybackGate } from '../../web/src/voice/events';

const event = (
  sequence: number,
  type: 'clear' | 'audio_started' = 'clear',
  generation = 1,
  at_ms = 0,
): VoiceEvent => ({
  sequence,
  type,
  generation,
  at_ms,
  server_time_ms: 0,
});
const batch = (events: VoiceEvent[], overrides: Partial<EventBatch> = {}): EventBatch => ({
  call_id: 'call',
  phase: 'active',
  active: true,
  ready: true,
  generation: 1,
  expires_at_ms: 0,
  finish_reason: null,
  cleanup_complete: false,
  timings: [],
  server_time_ms: 0,
  earliest_sequence: events[0]?.sequence ?? 0,
  last_sequence: events.at(-1)?.sequence ?? 0,
  events,
  ...overrides,
});

describe('event delivery', () => {
  it('orders and deduplicates overlapping responses', () => {
    const cursor = new EventCursor();
    const accepted: number[] = [];
    cursor.consume(batch([event(2), event(1)], { earliest_sequence: 1, last_sequence: 2 }), (e) =>
      accepted.push(e.sequence),
    );
    cursor.consume(batch([event(2), event(3)]), (e) => accepted.push(e.sequence));
    expect(accepted).toEqual([1, 2, 3]);
  });
  it('rejects a missing interruption instead of jumping the cursor', () => {
    const cursor = new EventCursor();
    expect(() => cursor.consume(batch([event(2)]), () => {})).toThrow();
    expect(cursor.sequence).toBe(0);
  });
  it('rejects a reset or incomplete journal', () => {
    const cursor = new EventCursor();
    cursor.consume(batch([event(1)]), () => {});
    expect(() => cursor.consume(batch([]), () => {})).toThrow();
    expect(() =>
      cursor.consume(batch([], { earliest_sequence: 1, last_sequence: 2 }), () => {}),
    ).toThrow();
  });
});

describe('interrupted playback', () => {
  it('mutes at clear and refuses audio from an older generation', () => {
    const gate = new PlaybackGate();
    expect(gate.accept(event(1, 'clear', 3, 1000))).toBe(-1);
    expect(gate.accept(event(2, 'audio_started', 2, 1500))).toBeUndefined();
    expect(gate.accept(event(3, 'audio_started', 3, 1100))).toBe(650);
  });
  it('uses server-relative time instead of adding the guard twice after polling', () => {
    const gate = new PlaybackGate();
    gate.accept(event(1, 'clear', 1, 1000));
    expect(gate.accept(event(2, 'audio_started', 1, 2000))).toBe(0);
  });
});
