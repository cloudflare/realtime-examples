import type { RGB, Telemetry } from '@/shared/contracts/robot.ts';
import type { RoomStatus } from '@/shared/contracts/signaling.ts';
import type { NowPlaying } from '@/shared/contracts/track.ts';
import type { SpectrumFrame } from './protocol.ts';

export type SignalBuffer = { frame?: SpectrumFrame; at: number; count: number };
export type ConnectionPhase = 'idle' | 'connecting' | 'connected';
export type AccessState = 'checking' | 'required' | 'ready';
export type IssueSource = 'status' | 'heartbeat' | 'connection' | 'control';
export type CommandAck = {
  state: 'idle' | 'pending' | 'confirmed' | 'error';
  text: string;
  at: number;
  rtt?: number;
};
export type SessionState = {
  phase: ConnectionPhase;
  auth: AccessState;
  room: RoomStatus;
  viewerId?: string;
  telemetry?: Telemetry;
  led?: RGB;
  nowPlaying?: NowPlaying;
  paused?: boolean;
  message: string;
  issues: Partial<Record<IssueSource, string>>;
  busy: boolean;
  ack: CommandAck;
  muted: boolean;
  volume: number;
  audioBlocked: boolean;
  now: number;
  telemetryAt: number;
  received: number;
  spectrumCount: number;
  audio: { packets: number; bytes: number; kbps: number; lost: number; at: number };
};
export const initialState = (): SessionState => ({
  phase: 'idle',
  auth: 'checking',
  room: { online: false, viewers: 0, controller: null, generation: null },
  message: 'Checking the board…',
  issues: {},
  busy: false,
  ack: { state: 'idle', text: '', at: 0 },
  muted: false,
  volume: 0.45,
  audioBlocked: false,
  now: 0,
  telemetryAt: 0,
  received: 0,
  spectrumCount: 0,
  audio: { packets: 0, bytes: 0, kbps: 0, lost: 0, at: 0 },
});
