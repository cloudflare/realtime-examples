import { Headphones, Mic, MicOff, PhoneOff, Volume2, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { describeStage, type CallView, type StageView } from '../voice/model';
import { Button } from './Button';
import { Orb } from './Orb';

function duration(seconds: number) {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function CallStage({
  view,
  name,
  toolsEnabled,
  maxCallSeconds,
  startControl,
  onStop,
  onMute,
  onResume,
}: {
  view: CallView;
  name: string;
  toolsEnabled: boolean;
  maxCallSeconds?: number;
  startControl: ReactNode;
  onStop: () => void;
  onMute: () => void;
  onResume: () => void;
}) {
  const stage = describeStage(view, name, toolsEnabled, maxCallSeconds);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (view.phase === 'idle' || view.phase === 'connecting') setElapsed(0);
    if (view.phase !== 'connected' || !view.connectedAt) return;
    setElapsed(Math.floor((Date.now() - view.connectedAt) / 1000));
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - view.connectedAt!) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [view.phase, view.connectedAt]);

  return (
    // A fixed height on large screens keeps the card still across call states
    // and gives the side panel room for the settings without scrolling.
    <section className="flex flex-col p-3 sm:p-5 lg:h-[42rem]" aria-label="Voice call">
      <div className="flex flex-1 flex-col rounded-xl bg-stone-900 p-3 sm:p-4">
        {/* Extra bottom padding keeps the centered copy clear of the corner chips. */}
        <div className="relative flex min-h-[22rem] flex-1 flex-col items-center justify-center rounded-lg border border-white/10 bg-stone-800 px-6 pt-10 pb-16 text-center sm:min-h-[26rem] sm:px-10 lg:min-h-0">
          <Orb controls={stage.controls} userLevel={view.userLevel} agentLevel={view.agentLevel} />
          <h1 className="max-w-md text-2xl leading-tight font-semibold tracking-tight text-balance text-stone-50 sm:text-3xl">
            {stage.heading}
          </h1>
          <p className="mt-3 max-w-md text-sm leading-6 text-pretty text-stone-400">
            {stage.subheading}
          </p>
          {stage.showHeadphonesTip && (
            <p className="mt-6 flex items-center gap-2 text-xs text-stone-400">
              <Headphones className="size-3.5" aria-hidden="true" /> Headphones make for a clearer
              conversation.
            </p>
          )}
          {stage.showEnableAudio && (
            <Button tone="primary" className="mt-6" onClick={onResume}>
              <Volume2 className="size-4" aria-hidden="true" /> Enable audio
            </Button>
          )}
          <p className="absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] truncate rounded-md bg-stone-950/80 px-2.5 py-1.5 text-xs font-medium text-white">
            {name.trim() || 'Assistant'}
            {stage.activity && <span className="text-stone-400"> · {stage.activity}</span>}
          </p>
          {stage.showTimer && (
            <p className="absolute right-3 bottom-3 rounded-md bg-stone-950/80 px-2.5 py-1.5 font-mono text-xs text-stone-200 tabular-nums">
              <span className="sr-only">Call duration </span>
              {duration(elapsed)}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {stage.microphone !== 'hidden' && (
          <Microphone state={stage.microphone} level={view.userLevel} />
        )}
        <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-2">
          <Controls
            kind={stage.controls}
            muted={view.muted}
            startControl={startControl}
            onMute={onMute}
            onStop={onStop}
          />
        </div>
      </div>
    </section>
  );
}

const microphoneStyles = {
  off: { label: 'Microphone off', icon: MicOff },
  muted: { label: 'Microphone muted', icon: MicOff },
  live: { label: 'Microphone on', icon: Mic },
} satisfies Record<Exclude<StageView['microphone'], 'hidden'>, { label: string; icon: LucideIcon }>;
const levelBars = [0.55, 0.85, 1, 0.75, 0.45];

function Microphone({
  state,
  level,
}: {
  state: Exclude<StageView['microphone'], 'hidden'>;
  level: number;
}) {
  const { label, icon: Icon } = microphoneStyles[state];
  return (
    <p className="flex items-center gap-2 text-sm text-stone-600">
      <Icon className="size-4" aria-hidden="true" />
      <span>{label}</span>
      {state === 'live' && (
        <span className="flex h-4 items-center gap-0.5" aria-hidden="true">
          {levelBars.map((scale, index) => (
            <span
              key={index}
              className="h-4 w-0.5 origin-center rounded-full bg-orange-600 transition-transform duration-100 motion-reduce:transition-none"
              style={{ transform: `scaleY(${Math.max(0.125, Math.min(1, level * scale))})` }}
            />
          ))}
        </span>
      )}
    </p>
  );
}

function Controls({
  kind,
  muted,
  startControl,
  onMute,
  onStop,
}: {
  kind: StageView['controls'];
  muted: boolean;
  startControl: ReactNode;
  onMute: () => void;
  onStop: () => void;
}) {
  switch (kind) {
    case 'start':
      return startControl;
    case 'cancel':
      return (
        <Button tone="danger" onClick={onStop}>
          <PhoneOff className="size-4" aria-hidden="true" /> Cancel
        </Button>
      );
    case 'ending':
      return (
        <Button tone="danger" disabled>
          <PhoneOff className="size-4" aria-hidden="true" /> Ending...
        </Button>
      );
    case 'call':
      return (
        <>
          <Button
            onClick={onMute}
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed={muted}
          >
            {muted ? (
              <MicOff className="size-4" aria-hidden="true" />
            ) : (
              <Mic className="size-4" aria-hidden="true" />
            )}
            {muted ? 'Unmute' : 'Mute'}
          </Button>
          <Button tone="danger" onClick={onStop}>
            <PhoneOff className="size-4" aria-hidden="true" /> End call
          </Button>
        </>
      );
  }
}
