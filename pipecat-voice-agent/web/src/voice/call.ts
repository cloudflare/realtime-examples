import { ApiError, describeError, request } from '../lib/api';
import {
  attachedSchema,
  callSchema,
  eventsSchema,
  negotiationSchema,
  warmedSchema,
  type AgentSettings,
  type VoiceEvent,
} from '../lib/contracts';
import { StartupTimings } from '../lib/timing';
import { CallAudio } from './audio';
import { applyConversationEvent, interruptResponses } from './conversation';
import { EventCursor, PlaybackGate } from './events';
import { describeCallEnd, idleCall, isCallBusy, nextActivity } from './model';
import { connected, firstCandidate } from './peer';

import type { CallView } from './model';
const pendingCallKey = 'voice-pending-call';
// Warming more often than this adds requests without keeping the object any warmer.
const warmGapMs = 5_000;
// The assistant's audio can reach the browser in bursts. Without this floor,
// the browser buffers too little for some bursts and fills the gap with
// stretched audio, which sounds like a hiccup. It adds under 0.1 s of delay.
const playoutBufferMs = 250;
type Run = {
  id: string;
  cancelled: boolean;
  created: boolean;
  createRequested: boolean;
  abort: AbortController;
  cursor: EventCursor;
  gate: PlaybackGate;
  timings: StartupTimings;
  audio: CallAudio;
  pc?: RTCPeerConnection;
  inflight?: Promise<unknown>;
  stopping?: Promise<void>;
  ready: boolean;
  resumeTimer?: ReturnType<typeof setTimeout>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
};

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function newCallId() {
  return crypto.randomUUID().replaceAll('-', '');
}

export class VoiceCall {
  private view = idleCall();
  private listeners = new Set<() => void>();
  private current?: Run;
  private recovering?: Promise<void>;
  private nextCallId?: string;
  private warmedAt = -Infinity;
  snapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<CallView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private check(run: Run) {
    if (run.cancelled || this.current !== run)
      throw new DOMException('Call cancelled', 'AbortError');
  }
  private async operation<T>(run: Run, label: string, name: string, action: () => Promise<T>) {
    this.check(run);
    this.update({ status: label });
    const result = await run.timings.measure(name, label, action);
    this.check(run);
    return result;
  }
  private control<T>(run: Run, action: () => Promise<T>): Promise<T> {
    const pending = action();
    run.inflight = pending;
    return pending;
  }

  /**
   * Starts the next call's Durable Object ahead of the click. A new object's
   * first request includes its cold start, which would otherwise delay
   * creating the call. Warming creates nothing on the server.
   */
  warm() {
    if (isCallBusy(this.view) || this.recovering) return;
    const now = performance.now();
    if (now - this.warmedAt < warmGapMs) return;
    this.warmedAt = now;
    this.nextCallId ??= newCallId();
    void request(`calls/${this.nextCallId}/warm`, warmedSchema, { timeout: 10_000 }).catch(
      () => {},
    );
  }

  async start(agent: AgentSettings, deviceId?: string) {
    if (isCallBusy(this.view)) return;
    const callId = this.nextCallId ?? newCallId();
    this.nextCallId = undefined;
    this.update({
      ...idleCall(),
      error: undefined,
      agentName: agent.name,
      callId,
      startedAt: Date.now(),
      connectedAt: undefined,
      phase: 'connecting',
      status: 'Allow microphone access...',
    });
    let pending: Run | undefined;
    try {
      const run: Run = {
        id: callId,
        cancelled: false,
        created: false,
        createRequested: false,
        abort: new AbortController(),
        cursor: new EventCursor(),
        gate: new PlaybackGate(),
        ready: false,
        timings: new StartupTimings((row) => {
          if (this.current === run) this.update({ timings: [...this.view.timings, row] });
        }),
        audio: new CallAudio(),
      };
      pending = run;
      this.current = run;
      // The offer needs only the outgoing track, which the audio graph already
      // has, so network setup runs while the person answers the microphone
      // prompt. The call itself is created only once the microphone is open.
      const { pc, transceiver } = this.connect(run);
      const offer = run.timings.measure('offer', 'Prepare the audio connection', async () => {
        await pc.setLocalDescription(await pc.createOffer());
        return firstCandidate(pc, 'offer', run.abort.signal);
      });
      // Awaited before publishing. A microphone failure must not leave its
      // rejection unhandled.
      offer.catch(() => undefined);
      await this.operation(run, 'Open microphone', 'microphone', () =>
        run.audio.open(deviceId, (userLevel, agentLevel) => {
          if (this.current === run && !run.cancelled)
            this.update({
              userLevel,
              agentLevel,
              playbackBlocked: run.audio.playbackBlocked || run.audio.context.state === 'suspended',
            });
        }),
      );
      run.audio.muteMicrophone(this.view.muted);
      this.update({ microphoneActive: true });
      run.createRequested = true;
      sessionStorage.setItem(pendingCallKey, run.id);
      await this.operation(run, 'Create your call', 'create_call', () =>
        this.control(run, async () => {
          const result = await request(`calls/${run.id}/create`, callSchema, { body: { agent } });
          run.created = true;
          return result;
        }),
      );
      const published = await this.operation(
        run,
        'Connect your microphone',
        'publish',
        async () => {
          const description = await offer;
          this.check(run);
          const result = await this.control(run, () =>
            request(`calls/${run.id}/publish`, negotiationSchema, {
              body: { mid: transceiver.mid, sessionDescription: description },
            }),
          );
          this.check(run);
          if (result.sessionDescription?.type !== 'answer') throw new Error('Missing media answer');
          await pc.setRemoteDescription(result.sessionDescription);
          return result;
        },
      );
      run.timings.server(published.timings);
      await this.operation(run, 'Connect to the audio service', 'connect_publish', () =>
        connected(pc, run.abort.signal),
      );
      const attached = await this.operation(run, 'Connect your assistant', 'attach', () =>
        this.control(run, () =>
          request(`calls/${run.id}/attach`, attachedSchema, { body: {}, timeout: 85_000 }),
        ),
      );
      run.timings.server(attached.timings);
      const subscription = await this.operation(run, 'Connect assistant audio', 'subscribe', () =>
        this.control(run, () =>
          request(`calls/${run.id}/subscribe`, negotiationSchema, { body: {} }),
        ),
      );
      run.timings.server(subscription.timings);
      if (subscription.sessionDescription?.type !== 'offer') throw new Error('Missing media offer');
      const negotiated = await this.operation(run, 'Finish connecting', 'renegotiate', async () => {
        await pc.setRemoteDescription(subscription.sessionDescription!);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const description = await firstCandidate(pc, 'answer', run.abort.signal);
        this.check(run);
        const result = await this.control(run, () =>
          request(`calls/${run.id}/renegotiate`, negotiationSchema, {
            body: { sessionDescription: description },
          }),
        );
        this.check(run);
        await connected(pc, run.abort.signal);
        return result;
      });
      run.timings.server(negotiated.timings);
      void this.poll(run);
      await this.operation(run, 'Wait for your assistant', 'ready', async () => {
        const deadline = performance.now() + 30_000;
        while (!run.ready || !run.audio.hasRemoteAudio) {
          this.check(run);
          if (performance.now() > deadline)
            throw new DOMException('Assistant timed out', 'TimeoutError');
          await delay(50, run.abort.signal);
        }
      });
      run.timings.complete();
      this.update({ phase: 'connected', connectedAt: Date.now(), status: 'Connected. Say hello.' });
    } catch (error) {
      if (pending) {
        if (!pending.cancelled) await this.fail(pending, describeError(error));
      } else {
        this.current = undefined;
        this.update({
          phase: 'ended',
          error: 'Audio could not be initialized. Check your browser audio settings and try again.',
        });
      }
    }
  }

  /** Creates the peer connection that sends the outgoing track and plays the assistant. */
  private connect(run: Run) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      bundlePolicy: 'max-bundle',
    });
    run.pc = pc;
    pc.ontrack = (event) => {
      if ('jitterBufferTarget' in event.receiver)
        event.receiver.jitterBufferTarget = playoutBufferMs;
      if (!run.cancelled) void run.audio.receive(event.track);
    };
    pc.onconnectionstatechange = () => {
      clearTimeout(run.disconnectTimer);
      if (run.cancelled || this.view.phase !== 'connected') return;
      if (pc.connectionState === 'failed')
        void this.fail(run, 'The audio connection was lost. Please start a new call.');
      if (pc.connectionState === 'disconnected')
        run.disconnectTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected')
            void this.fail(run, 'The audio connection was lost. Please start a new call.');
        }, 8000);
    };
    const track = run.audio.outgoing.stream.getAudioTracks()[0];
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [run.audio.outgoing.stream],
    });
    const opus = RTCRtpSender.getCapabilities('audio')?.codecs.filter(
      (codec) => codec.mimeType.toLowerCase() === 'audio/opus',
    );
    if (opus?.length) transceiver.setCodecPreferences(opus);
    return { pc, transceiver };
  }

  private async poll(run: Run) {
    let failures = 0;
    while (!run.cancelled && this.current === run) {
      try {
        const batch = await request(
          `calls/${run.id}/events?after=${run.cursor.sequence}`,
          eventsSchema,
          { signal: run.abort.signal, timeout: 30_000 },
        );
        this.check(run);
        // A reconstructed DO has no in-memory conversation and ends its call.
        // Honor termination before interpreting the resulting empty journal.
        if (['ending', 'ended'].includes(batch.phase)) {
          const ending = describeCallEnd(batch.finish_reason);
          this.update(ending);
          await this.stop(ending.status);
          return;
        }
        run.cursor.consume(batch, (event) => this.onEvent(run, event));
        run.ready ||= batch.ready;
        failures = 0;
      } catch (error) {
        if (run.cancelled) return;
        failures += 1;
        // Retry a transient HTTP failure, but never skip a missing clear or
        // transcript event: that would corrupt playback or conversation state.
        if (
          failures >= 3 ||
          !(
            error instanceof TypeError ||
            error instanceof ApiError ||
            error instanceof DOMException
          )
        ) {
          await this.fail(run, describeError(error));
          return;
        }
      }
      if (failures) {
        try {
          await delay(1000, run.abort.signal);
        } catch {
          return;
        }
      }
    }
  }

  private onEvent(run: Run, event: VoiceEvent) {
    if (run.cancelled || this.current !== run) return;
    if ('generation' in event && event.generation < run.gate.generation) return;
    const resumeDelay = run.gate.accept(event);
    if (resumeDelay !== undefined) {
      clearTimeout(run.resumeTimer);
      if (resumeDelay < 0) run.audio.setPlayback(false);
      else {
        const generation = run.gate.generation;
        run.resumeTimer = setTimeout(() => {
          if (!run.cancelled && run.gate.generation === generation) run.audio.setPlayback(true);
        }, resumeDelay);
      }
    }
    const history = applyConversationEvent(this.view.history, event, run.gate.generation);
    const activity = nextActivity(this.view, event, history);
    if (history !== this.view.history || activity !== this.view.activity)
      this.update({ history, activity });
    if (event.type === 'error' || event.type === 'pipeline_error') {
      void this.fail(run, 'The assistant encountered a problem. Please start a new call.');
    }
  }

  private async fail(run: Run, message: string) {
    if (this.current !== run || run.cancelled) return;
    this.update({ error: message });
    await this.stop();
  }

  toggleMute() {
    const muted = !this.view.muted;
    this.current?.audio.muteMicrophone(muted);
    this.update({ muted });
  }

  async resumeAudio() {
    try {
      await this.current?.audio.resume();
      this.update({ playbackBlocked: false });
    } catch {
      this.update({
        playbackBlocked: true,
        error: "Audio playback is blocked. Check your browser's sound permissions.",
      });
    }
  }

  stop(message = 'Call ended. Your microphone is off.') {
    const run = this.current;
    if (!run) return Promise.resolve();
    if (run.stopping) return run.stopping;
    run.cancelled = true;
    run.abort.abort();
    clearTimeout(run.resumeTimer);
    clearTimeout(run.disconnectTimer);
    run.audio.stopCapture();
    this.update({
      phase: 'ending',
      status: 'Ending call...',
      userLevel: 0,
      agentLevel: 0,
      microphoneActive: false,
      history: interruptResponses(this.view.history),
    });
    // Finish can queue behind an in-flight mutation. Never abort that HTTP
    // mutation and then forget whether it created a resource.
    run.stopping = (async () => {
      let cleanupPending = false;
      try {
        if (run.createRequested) {
          if (!run.created) await run.inflight?.catch(() => undefined);
          const result = await request(`calls/${run.id}/finish`, callSchema, {
            body: {},
            timeout: 90_000,
          });
          cleanupPending = !result.cleanup_complete;
          if (!cleanupPending && sessionStorage.getItem(pendingCallKey) === run.id)
            sessionStorage.removeItem(pendingCallKey);
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404)
          sessionStorage.removeItem(pendingCallKey);
        else cleanupPending = true;
      }
      // Keep the media session reachable until its server-owned tracks have
      // been closed. Capture and playback were stopped immediately above.
      run.pc?.close();
      await run.audio.close();
      if (this.current === run) this.update({ phase: 'ended', status: message, cleanupPending });
    })();
    return run.stopping;
  }

  unload = () => {
    const run = this.current;
    if (!run || run.cancelled) return;
    run.cancelled = true;
    run.abort.abort();
    clearTimeout(run.resumeTimer);
    clearTimeout(run.disconnectTimer);
    run.pc?.close();
    void run.audio.close();
    if (run.created)
      void request(`calls/${run.id}/finish`, callSchema, { body: {}, keepalive: true }).catch(
        () => {},
      );
  };

  recover() {
    if (this.recovering) return this.recovering;
    if (isCallBusy(this.view)) return Promise.resolve();
    const id = sessionStorage.getItem(pendingCallKey);
    if (!id || !/^[a-f0-9]{32}$/.test(id)) return Promise.resolve();
    this.update({ phase: 'ending', status: 'Finishing your previous call...' });
    this.recovering = (async () => {
      try {
        const result = await request(`calls/${id}/finish`, callSchema, {
          body: {},
          timeout: 90_000,
        });
        if (result.cleanup_complete) sessionStorage.removeItem(pendingCallKey);
        this.update({
          phase: 'idle',
          status: 'Ready when you are.',
          cleanupPending: !result.cleanup_complete,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404)
          sessionStorage.removeItem(pendingCallKey);
        this.update({
          phase: 'idle',
          status: 'Ready when you are.',
          cleanupPending: !(error instanceof ApiError && error.status === 404),
        });
      }
    })().finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }
}
