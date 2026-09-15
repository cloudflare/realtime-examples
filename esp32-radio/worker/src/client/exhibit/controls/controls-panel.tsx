import type { Command, RGB, Telemetry } from '@/shared/contracts/robot.ts';
import type { AccessState, CommandAck } from '@/client/radio/session-state.ts';
import { ActionLabel } from '@/client/ui/action-label.tsx';
import { Icon } from '@/client/ui/icons.tsx';
import { BranchPanel } from '@/client/exhibit/branch-panel.tsx';
import type { ExplanationTrigger } from '@/client/exhibit/diagram/diagram-model.ts';
import { LedControls } from './led-controls.tsx';
import { TelemetryReadout } from './telemetry-readout.tsx';

type Props = ExplanationTrigger & {
  telemetry?: Telemetry;
  trackCount: number;
  paused: boolean;
  led?: RGB;
  auth: AccessState;
  connected: boolean;
  held: boolean;
  occupied: boolean;
  busy: boolean;
  ack: CommandAck;
  live: boolean;
  onToggleControl: () => void;
  onSend: (command: Command) => void;
};

export function ControlsPanel({
  telemetry,
  trackCount,
  paused,
  led,
  auth,
  connected,
  held,
  occupied,
  busy,
  ack,
  live,
  onToggleControl,
  onSend,
  ...explanation
}: Props) {
  const pending = ack.state === 'pending';
  const canSend = held && !pending;
  const canToggle = connected && !busy && !occupied;
  const send = (command: Command) => {
    if (canSend) onSend(command);
  };
  return (
    <BranchPanel
      branch="robot"
      label="Telemetry and board controls"
      title="Telemetry & controls"
      caption="RELIABLE DATA CHANNEL"
      live={live}
      {...explanation}
    >
      <TelemetryReadout telemetry={telemetry} />
      <div className="mt-2.5 flex min-h-[3lh] items-center justify-between gap-2 text-[11px] leading-4.5 [&>span]:max-w-[18ch] [&>span]:text-[11px] [&>span]:text-muted">
        <span>
          {auth === 'checking'
            ? 'Checking access…'
            : auth === 'required'
              ? 'Unlock access to use the controls.'
              : !connected
                ? 'Start listening to use the controls.'
                : held
                  ? 'You have control'
                  : occupied
                    ? 'Another listener has control'
                    : 'Controls available'}
        </span>
        <button
          id="claim"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-medium whitespace-nowrap px-2 text-[11px] enabled:hover:bg-core [&_svg]:size-3"
          disabled={!connected || occupied}
          aria-disabled={!canToggle}
          aria-busy={busy}
          onClick={() => {
            if (canToggle) void onToggleControl();
          }}
        >
          <ActionLabel
            value={busy ? 'Updating…' : held ? 'Release control' : 'Take control'}
            alternatives={['Updating…', 'Release control', 'Take control']}
          />
          <Icon name="arrow" />
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        LED and playback changes affect everyone.
      </p>
      <LedControls
        led={led}
        disabled={!held}
        pending={pending}
        onChange={(rgb) => send({ led: rgb })}
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 [&>span]:mr-auto [&>span]:max-w-[12ch] [&>span]:font-mono [&>span]:text-[8px] [&>span]:tracking-wide [&>span]:text-muted">
        <span>PLAYBACK</span>
        <button
          id="pause"
          className="inline-flex min-h-10 items-center gap-1.5 text-xs underline-offset-4 enabled:hover:underline [&_svg]:size-3"
          disabled={!held}
          aria-disabled={!canSend}
          onClick={() => send({ action: paused ? 'play' : 'pause' })}
        >
          <Icon name={paused ? 'play' : 'pause'} />
          <ActionLabel
            value={paused ? 'Resume track' : 'Pause track'}
            alternatives={['Resume track', 'Pause track']}
          />
        </button>
        <button
          id="restart"
          className="inline-flex min-h-10 items-center gap-1.5 text-xs underline-offset-4 enabled:hover:underline [&_svg]:size-3"
          disabled={!held}
          aria-disabled={!canSend}
          onClick={() => send({ action: 'restart' })}
        >
          <Icon name="restart" />
          Restart
        </button>
        <button
          id="next-track"
          className="inline-flex min-h-10 items-center gap-1.5 text-xs underline-offset-4 enabled:hover:underline [&_svg]:size-3"
          disabled={!held || trackCount < 2}
          aria-disabled={!canSend || trackCount < 2}
          onClick={() => {
            if (trackCount > 1) send({ action: 'next' });
          }}
        >
          <Icon name="arrow" />
          Next track
        </button>
      </div>
      <div className="@container">
        <p
          className={`min-h-[2lh] text-[11px] leading-4.5 wrap-anywhere text-muted @min-[15rem]:min-h-[1lh] ${ack.state === 'confirmed' ? 'text-spectrum' : ack.state === 'pending' ? 'text-robot' : ack.state === 'error' ? 'text-error' : ''}`}
          role="status"
          aria-live="polite"
          data-testid="ack"
        >
          {ack.state === 'confirmed' ? '✓ ' : ack.state === 'pending' ? '↖ ' : ''}
          {ack.text}
        </p>
      </div>
    </BranchPanel>
  );
}
