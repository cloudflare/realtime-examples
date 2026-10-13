import { describe, expect, it, vi } from 'vitest';
import { connected, firstCandidate } from '../../web/src/voice/peer';

class Peer extends EventTarget {
  connectionState = 'new';
  iceGatheringState = 'gathering';
  localDescription = { type: 'offer', sdp: 'v=0\r\n' };
  candidate() {
    this.localDescription.sdp += 'a=candidate:1 1 udp 1 192.0.2.1 10000 typ host\r\n';
    this.dispatchEvent(new Event('icecandidate'));
  }
  asRTC() {
    return this as unknown as RTCPeerConnection;
  }
}

describe('ICE negotiation', () => {
  it('releases on the first candidate with gathering still incomplete', async () => {
    const peer = new Peer();
    const pending = firstCandidate(peer.asRTC(), 'offer', new AbortController().signal);
    peer.candidate();
    expect((await pending).sdp).toContain('a=candidate:');
    expect(peer.iceGatheringState).toBe('gathering');
  });
  it('uses an already gathered candidate immediately', async () => {
    const peer = new Peer();
    peer.candidate();
    await expect(
      firstCandidate(peer.asRTC(), 'offer', new AbortController().signal),
    ).resolves.toMatchObject({ type: 'offer' });
  });
  it('fails closed with zero candidates or cancellation', async () => {
    const peer = new Peer();
    peer.iceGatheringState = 'complete';
    await expect(
      firstCandidate(peer.asRTC(), 'offer', new AbortController().signal),
    ).rejects.toThrow('No network path');
    const aborted = new AbortController();
    aborted.abort();
    await expect(connected(peer.asRTC(), aborted.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
  it('bounds a wait without candidates', async () => {
    vi.useFakeTimers();
    const result = expect(
      firstCandidate(new Peer().asRTC(), 'offer', new AbortController().signal, 100),
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    await result;
    vi.useRealTimers();
  });
});
