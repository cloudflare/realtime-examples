import type { EventBatch, VoiceEvent } from '../lib/contracts';

export class EventCursor {
  sequence = 0;

  consume(batch: EventBatch, accept: (event: VoiceEvent) => void) {
    if (batch.last_sequence < this.sequence || batch.earliest_sequence > this.sequence + 1) {
      throw new Error('The call event stream was interrupted.');
    }
    for (const event of [...batch.events].sort((a, b) => a.sequence - b.sequence)) {
      if (event.sequence <= this.sequence) continue;
      if (event.sequence !== this.sequence + 1) throw new Error('Missing call event.');
      this.sequence = event.sequence;
      accept(event);
    }
    if (this.sequence !== batch.last_sequence) throw new Error('Incomplete call event stream.');
  }
}

// This is a browser playback policy, not an SFU buffer flush. After an
// interruption, keep old queued audio muted until the next generation begins.
export class PlaybackGate {
  generation = 0;
  private clearAt: number | undefined;

  accept(event: VoiceEvent): number | undefined {
    if (event.type !== 'clear' && event.type !== 'audio_started') return;
    if (event.generation < this.generation) return;
    this.generation = event.generation;
    if (event.type === 'clear') {
      this.clearAt = event.at_ms;
      return -1;
    }
    return this.clearAt === undefined ? 0 : Math.max(0, 750 - (event.at_ms - this.clearAt));
  }
}
