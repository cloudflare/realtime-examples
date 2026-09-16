import { ActionLabel } from '@/client/ui/action-label.tsx';
import { TrackMetadata } from './track-metadata.tsx';
import type { Track } from '@/shared/contracts/track.ts';
import type { ConnectionPhase } from '@/client/radio/session-state.ts';
import { formatTime } from '@/client/ui/format.ts';
import { Icon } from '@/client/ui/icons.tsx';
import { BranchPanel } from '@/client/exhibit/branch-panel.tsx';
import type { ExplanationTrigger } from '@/client/exhibit/diagram/diagram-model.ts';

const connectionLabels = ['Start listening', 'Cancel connection', 'Disconnect'] as const;
const soundLabels = ['Mute', 'Unmute', 'Enable sound'] as const;

type Props = ExplanationTrigger & {
  phase: ConnectionPhase;
  available: boolean;
  track?: Track;
  position: number;
  duration: number;
  kbps: number;
  live: boolean;
  muted: boolean;
  volume: number;
  audioBlocked: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleAudio: () => void;
  onVolumeChange: (volume: number) => void;
};

export function AudioPanel({
  phase,
  available,
  track,
  position,
  duration,
  kbps,
  live,
  muted,
  volume,
  audioBlocked,
  onConnect,
  onDisconnect,
  onToggleAudio,
  onVolumeChange,
  ...explanation
}: Props) {
  const connected = phase === 'connected',
    connecting = phase === 'connecting';
  const soundLabel = audioBlocked ? 'Enable sound' : muted ? 'Unmute' : 'Mute';
  return (
    <BranchPanel
      branch="audio"
      label="Audio stream"
      title="Listen in."
      caption="OPUS AUDIO · 48 kHz STEREO"
      live={live}
      {...explanation}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <TrackMetadata track={track} />
        <span className="w-[10ch] shrink-0 pt-1 text-right font-mono text-[9px] text-muted">
          {live ? `${Math.round(kbps)} kb/s` : 'FROM FLASH'}
        </span>
      </div>
      <div className="my-3 flex items-center gap-3 [&>div]:h-[3px] [&>div]:flex-1 [&>div]:overflow-hidden [&>div]:rounded [&>div]:bg-core [&>div>span]:block [&>div>span]:size-full [&>div>span]:origin-left [&>div>span]:bg-audio [&>span]:font-mono [&>span]:text-[10px] [&>span>span]:text-muted">
        <div
          role="progressbar"
          aria-label="Track position"
          aria-valuemin={0}
          aria-valuemax={duration || 1}
          aria-valuenow={position}
        >
          <span
            style={{ transform: `scaleX(${duration ? Math.min(1, position / duration) : 0})` }}
          />
        </div>
        <span>
          {formatTime(position)} <span>/ {duration ? formatTime(duration) : '–:––'}</span>
        </span>
      </div>
      <div className="@container">
        <div className="grid justify-items-start gap-2 @min-[24rem]:grid-cols-[max-content_minmax(0,1fr)] @min-[24rem]:items-center">
          <button
            id="connect"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-medium whitespace-nowrap border-ink bg-ink text-paper enabled:hover:bg-ink-hover"
            disabled={!available}
            onClick={() => {
              if (phase !== 'idle') void onDisconnect();
              else void onConnect();
            }}
          >
            <Icon name={connected ? 'pause' : 'play'} />
            <ActionLabel
              value={
                connecting ? 'Cancel connection' : connected ? 'Disconnect' : 'Start listening'
              }
              alternatives={connectionLabels}
            />
          </button>
          <div className="flex w-full min-w-0 items-center gap-2">
            <button
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded px-2 text-xs enabled:hover:bg-core"
              disabled={!connected}
              aria-label={soundLabel}
              onClick={() => {
                void onToggleAudio();
              }}
            >
              <Icon name={muted ? 'muted' : 'sound'} />
              <ActionLabel value={soundLabel} alternatives={soundLabels} />
            </button>
            <label className="flex min-w-12 max-w-[105px] flex-1 flex-col [&_input]:h-11 [&_input]:w-full [&_input]:accent-ink">
              <span className="text-[9px] text-muted">Your volume</span>
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(volume * 100)}
                onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
                aria-label="Listening volume"
              />
            </label>
          </div>
        </div>
      </div>
    </BranchPanel>
  );
}
