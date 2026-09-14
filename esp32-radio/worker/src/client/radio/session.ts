import { acceptMetadata, matchesPlayback } from './playback.ts';
import type { NowPlaying } from '@/shared/contracts/track.ts';
import { radioApi, ApiError, errorText } from './api.ts';
import type { RadioApi } from './api.ts';
import { commandId, parseRobot, parseSpectrum } from './protocol.ts';
import type { Command } from '@/shared/contracts/robot.ts';
import type { Joined } from '@/shared/contracts/signaling.ts';
import { initialState } from './session-state.ts';
import type { IssueSource, SessionState, SignalBuffer } from './session-state.ts';
import { acknowledge, gatheredAnswer } from './webrtc.ts';

/** Owns a viewer's peer, browser audio, timers, and command acknowledgments.
 * React subscribes to snapshots; the spectrum canvas reads a separate sample buffer.
 */
export class RadioSession {
  readonly signal: SignalBuffer = { at: 0, count: 0 };
  private state = initialState();
  private listeners = new Set<() => void>();
  private api: RadioApi;
  private peer?: RTCPeerConnection;
  private member?: Joined;
  private robot?: RTCDataChannel;
  private audio?: HTMLAudioElement;
  private context?: AudioContext;
  private source?: MediaElementAudioSourceNode;
  private epoch = 0;
  private pending?: { id: string; at: number; timer: ReturnType<typeof setTimeout> };
  private heartbeatBusy = false;
  private statusBusy = false;
  private statsBusy = false;

  constructor(api: RadioApi = radioApi) {
    this.api = api;
  }
  getSnapshot = (): SessionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private issue(source: IssueSource, message?: string) {
    this.update({ issues: { ...this.state.issues, [source]: message } });
  }
  get held(): boolean {
    return (
      this.state.phase === 'connected' &&
      !!this.member &&
      this.state.room.controller === this.member.id
    );
  }

  start(audio: HTMLAudioElement): () => void {
    this.audio = audio;
    audio.volume = this.state.volume;
    void this.refreshStatus();
    const statusTimer = setInterval(() => {
      if (!document.hidden) void this.refreshStatus();
    }, 5000);
    const heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, 5000);
    const clockTimer = setInterval(() => {
      this.update({ now: performance.now(), spectrumCount: this.signal.count });
      void this.collectStats();
    }, 1000);
    const pagehide = () => {
      if (this.member)
        navigator.sendBeacon(
          `/api/viewers/${this.member.id}/leave`,
          new Blob([JSON.stringify({ viewerToken: this.member.viewerToken })], {
            type: 'application/json',
          }),
        );
      if (this.peer || this.member || this.state.phase !== 'idle') void this.disconnect();
    };
    window.addEventListener('pagehide', pagehide);
    return () => {
      clearInterval(statusTimer);
      clearInterval(heartbeatTimer);
      clearInterval(clockTimer);
      window.removeEventListener('pagehide', pagehide);
      if (this.peer || this.member || this.state.phase !== 'idle') void this.disconnect();
      // A StrictMode effect replay can reuse the same media element. Keep its
      // one MediaElementSource and suspend the context until the next gesture.
      void this.context?.suspend();
    };
  }

  async refreshStatus(): Promise<void> {
    if (this.statusBusy) return;
    this.statusBusy = true;
    try {
      const room = await this.api.getStatus();
      const changed = room.generation !== this.state.room.generation;
      if (changed) {
        this.signal.frame = undefined;
        this.signal.at = 0;
        this.update({ nowPlaying: undefined, paused: undefined });
      }
      this.issue('status');
      this.update({ room, auth: 'ready' });
      if (room.nowPlaying) this.acceptNowPlaying(room.nowPlaying);
      if (this.member && (!room.online || room.generation !== this.member.generation)) {
        await this.disconnect('Board connection changed. Start listening when it is online.');
      } else if (this.state.phase === 'idle') {
        this.update({
          message: room.online
            ? 'Board online. Start listening.'
            : 'Board offline. You can still explore the diagram.',
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.issue('status');
        this.update({ auth: 'required' });
        if (this.member) await this.disconnect('Enter the viewer password to reconnect.');
      } else {
        this.issue('status', 'Radio service unavailable. Retrying shortly.');
      }
    } finally {
      this.statusBusy = false;
    }
  }

  async login(password: string): Promise<void> {
    await this.api.login(password);
    this.issue('connection');
    this.update({ auth: 'ready' });
    await this.refreshStatus();
  }

  async connect(): Promise<void> {
    if (this.state.phase !== 'idle' || !this.audio) return;
    const epoch = ++this.epoch;
    const current = () => {
      if (epoch !== this.epoch) throw new Error('Connection cancelled.');
    };
    this.issue('connection');
    this.update({ phase: 'connecting', message: 'Opening data channels…' });
    try {
      // Resume within the user gesture. There is no microphone or camera track.
      if (typeof AudioContext !== 'undefined') {
        this.context ??= new AudioContext();
        if (!this.source) {
          this.source = this.context.createMediaElementSource(this.audio);
          this.source.connect(this.context.destination);
        }
        await this.context.resume();
      }
      current();
      const peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      this.peer = peer;
      peer.ontrack = ({ track }) => {
        if (this.peer !== peer || track.kind !== 'audio' || !this.audio) return;
        this.audio.srcObject = new MediaStream([track]);
        void this.audio.play().catch(() => {
          if (this.peer === peer) this.update({ audioBlocked: true });
        });
      };
      peer.onconnectionstatechange = () => {
        if (this.peer !== peer) return;
        if (peer.connectionState === 'failed')
          void this.disconnect('Connection closed. Start listening again.');
        else if (peer.connectionState === 'disconnected')
          this.update({ message: 'Connection interrupted. Waiting for the signal…' });
        else if (peer.connectionState === 'connected' && this.state.phase === 'connected')
          this.update({ message: 'Connected to the board.' });
      };
      const joined = await this.api.joinViewer();
      if (epoch !== this.epoch) {
        await this.leave(joined);
        return;
      }
      this.member = joined;
      this.update({ viewerId: joined.id });
      await peer.setRemoteDescription(joined.sessionDescription);
      current();
      const answer = await gatheredAnswer(peer);
      current();
      const response = await this.api.answerViewer(joined, answer);
      current();
      const channels = response.channels.map((config) => {
        const channel = peer.createDataChannel(config.dataChannelName, {
          negotiated: true,
          id: config.id,
          ordered: config.ordered,
          ...('maxRetransmits' in config ? { maxRetransmits: config.maxRetransmits } : {}),
        });
        channel.binaryType = 'arraybuffer';
        channel.onmessage = (event) => {
          if (this.peer === peer) this.receive(config.dataChannelName, event.data);
        };
        channel.onclose = () => {
          if (this.peer === peer && this.state.phase === 'connected')
            void this.disconnect('Data channel closed. Start listening again.');
        };
        if (config.dataChannelName === 'robot') this.robot = channel;
        return channel;
      });
      await Promise.all(channels.map(acknowledge));
      current();
      this.update({ message: 'Connecting audio…' });
      const remote = await this.api.subscribeAudio(joined);
      current();
      await peer.setRemoteDescription(remote.sessionDescription);
      current();
      const audioAnswer = await gatheredAnswer(peer);
      current();
      await this.api.renegotiateViewer(joined, audioAnswer);
      current();
      this.update({ phase: 'connected', message: 'Connected to the board.' });
      await this.refreshStatus();
    } catch (error) {
      if (epoch === this.epoch) {
        await this.disconnect();
        this.issue('connection', errorText(error));
      }
    }
  }

  async disconnect(message = 'Disconnected. Shared playback is unchanged.'): Promise<void> {
    ++this.epoch;
    const leaving = this.member;
    this.member = undefined;
    const peer = this.peer;
    this.peer = undefined;
    this.robot = undefined;
    peer?.close();
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    clearTimeout(this.pending?.timer);
    this.pending = undefined;
    this.signal.frame = undefined;
    this.signal.at = 0;
    this.signal.count = 0;
    const initial = initialState();
    this.update({
      phase: 'idle',
      viewerId: undefined,
      paused: undefined,
      issues: { status: this.state.issues.status, connection: this.state.issues.connection },
      telemetry: undefined,
      led: undefined,
      telemetryAt: 0,
      received: 0,
      spectrumCount: 0,
      audio: initial.audio,
      ack: initial.ack,
      busy: false,
      audioBlocked: false,
      message,
    });
    if (leaving) await this.leave(leaving);
  }
  private async leave(member: Joined) {
    try {
      await this.api.leaveViewer(member);
    } catch {
      /* Server membership expires after inactivity. */
    }
  }
  private async heartbeat() {
    const member = this.member;
    if (!member || this.state.phase !== 'connected' || this.heartbeatBusy) return;
    this.heartbeatBusy = true;
    try {
      const result = await this.api.heartbeatViewer(member);
      if (this.member === member) {
        this.issue('heartbeat');
        this.update({ room: { ...this.state.room, controller: result.controller } });
      }
    } catch (error) {
      if (this.member !== member) return;
      this.issue('heartbeat', 'Connection renewal failed. Controls are unavailable.');
      this.update({ room: { ...this.state.room, controller: null } });
      if (error instanceof ApiError && [401, 403, 409].includes(error.status))
        await this.disconnect('Session expired. Start listening again.');
    } finally {
      this.heartbeatBusy = false;
    }
  }

  async toggleControl(): Promise<void> {
    const member = this.member;
    if (!member || this.state.phase !== 'connected' || this.state.busy) return;
    this.issue('control');
    this.update({ busy: true });
    try {
      const result = this.held
        ? await this.api.releaseControl(member)
        : await this.api.claimControl(member);
      if (this.member === member)
        this.update({ room: { ...this.state.room, controller: result.controller } });
    } catch (error) {
      if (this.member === member) this.issue('control', errorText(error));
    } finally {
      if (this.member === member) this.update({ busy: false });
    }
  }

  send(command: Command): void {
    if (!this.held || this.robot?.readyState !== 'open' || this.pending) return;
    if (this.robot.bufferedAmount > 4096) {
      this.update({
        ack: {
          state: 'error',
          text: 'Connection busy. Try again shortly.',
          at: performance.now(),
        },
      });
      return;
    }
    const id = commandId(),
      at = performance.now();
    const timer = setTimeout(() => {
      this.pending = undefined;
      this.update({
        ack: {
          state: 'error',
          text: 'No board confirmation. Try again.',
          at: performance.now(),
        },
      });
    }, 5000);
    this.pending = { id, at, timer };
    this.update({ ack: { state: 'pending', text: 'Waiting for board confirmation…', at } });
    try {
      this.robot.send(JSON.stringify({ ...command, command_id: id }));
    } catch {
      clearTimeout(timer);
      this.pending = undefined;
      this.update({
        ack: { state: 'error', text: 'Command not sent. Reconnect and try again.', at },
      });
    }
  }

  private acceptNowPlaying(next: NowPlaying) {
    const previous = this.state.nowPlaying;
    if (acceptMetadata(previous, next) === previous) return;
    this.signal.frame = undefined;
    this.signal.at = 0;
    this.update({
      nowPlaying: next,
    });
  }

  private receive(channel: 'robot' | 'spectrum', data: unknown) {
    const now = performance.now();
    if (channel === 'spectrum') {
      const frame = parseSpectrum(data, this.signal.frame?.pts);
      if (frame && matchesPlayback(frame.revision, this.state.nowPlaying)) {
        this.signal.frame = frame;
        this.signal.at = now;
        ++this.signal.count;
      }
      return;
    }
    const message = parseRobot(data);
    if (!message) return;
    if (message.event === 'nowPlaying') {
      this.acceptNowPlaying(message.nowPlaying);
    } else if (message.event === 'telemetry') {
      if (!matchesPlayback(message.playbackRevision, this.state.nowPlaying)) return;
      this.update({
        telemetry: message,
        paused: message.paused,
        led: message.led,
        telemetryAt: now,
        now,
        received: this.state.received + 1,
      });
    } else if (this.pending?.id === message.command_id) {
      const rtt = Math.round(now - this.pending.at);
      clearTimeout(this.pending.timer);
      this.pending = undefined;
      this.update({
        led: message.led,
        paused: message.paused,
        ack: {
          state: message.result === 0 ? 'confirmed' : 'error',
          text:
            message.result === 0
              ? `Board confirmed · ${rtt} ms round trip`
              : 'The board could not apply the command.',
          at: now,
          rtt,
        },
      });
    }
  }

  async toggleAudio(): Promise<void> {
    if (!this.audio || this.state.phase !== 'connected') return;
    try {
      if (this.state.audioBlocked || this.audio.paused) {
        await this.context?.resume();
        await this.audio.play();
        this.audio.muted = false;
      } else this.audio.muted = !this.audio.muted;
      this.update({ muted: this.audio.muted, audioBlocked: false });
    } catch {
      this.update({ audioBlocked: true });
    }
  }
  setVolume(volume: number) {
    const clamped = Math.max(0, Math.min(1, volume));
    if (this.audio) this.audio.volume = clamped;
    this.update({ volume: clamped });
  }
  private async collectStats() {
    const peer = this.peer;
    if (!peer || this.state.phase !== 'connected' || this.statsBusy) return;
    this.statsBusy = true;
    try {
      const report = await peer.getStats();
      if (this.peer !== peer) return;
      const now = performance.now();
      report.forEach((stat) => {
        if (stat.type !== 'inbound-rtp' || stat.kind !== 'audio') return;
        const previous = this.state.audio,
          bytes = Number(stat.bytesReceived ?? 0),
          packets = Number(stat.packetsReceived ?? 0);
        this.update({
          audio: {
            bytes,
            packets,
            lost: Number(stat.packetsLost ?? 0),
            kbps: previous.at
              ? Math.max(0, ((bytes - previous.bytes) * 8) / (now - previous.at))
              : 0,
            at: packets > previous.packets ? now : previous.at,
          },
        });
      });
    } catch {
      /* Browser statistics are optional; media and control keep working. */
    } finally {
      this.statsBusy = false;
    }
  }
}
