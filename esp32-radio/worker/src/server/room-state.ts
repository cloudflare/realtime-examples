import type { Channel } from '@/shared/contracts/channels.ts';
import type { Description } from '@/shared/contracts/signaling.ts';
import type { NowPlaying, Track } from '@/shared/contracts/track.ts';

// Primary session resources plus optional allocation receipts retained for cleanup.
export type SessionResources = {
  sessionId: string;
  channels: Channel[];
  mid?: string;
  pendingChannels?: number[];
  pendingMids?: string[];
};

// Keep additions optional so stored rooms from earlier Worker versions still load.
export type Publisher = SessionResources & {
  generation: string;
  ready: boolean;
  seen: number;
  bootId?: string;
  offerHash?: string;
  answer?: Description;
  track?: Track;
  nowPlaying?: NowPlaying;
  initialNowPlaying?: NowPlaying;
};
export type Viewer = SessionResources & {
  token: string;
  generation: string;
  seen: number;
  closing?: boolean;
};
export type RoomState = {
  publisher?: Publisher;
  viewers: Record<string, Viewer>;
  controller?: { id: string; until: number };
};
