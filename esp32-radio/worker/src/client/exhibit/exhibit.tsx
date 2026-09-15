import { useRef, useState } from 'react';
import { playbackView } from '@/client/radio/playback.ts';
import type { SessionState, SignalBuffer } from '@/client/radio/session-state.ts';
import type { RadioActions } from '@/client/radio/use-radio.ts';
import { Login } from '@/client/ui/login.tsx';
import { BoardNode } from './board/board-node.tsx';
import { AudioPanel } from './audio/audio-panel.tsx';
import { SpectrumPanel } from './spectrum/spectrum-panel.tsx';
import { ControlsPanel } from './controls/controls-panel.tsx';
import { SignalPopover } from './details/signal-popover.tsx';
import { SfuNode } from './diagram/sfu-node.tsx';
import { Wires } from './diagram/wires.tsx';
import { BRANCHES, branchStyles } from './diagram/diagram-model.ts';
import type { ExplanationTrigger, Selection, SignalDetails } from './diagram/diagram-model.ts';

/** Adapts the radio snapshot to the exhibit; panels receive only their own data and actions. */
export function Exhibit({
  state,
  signal,
  actions,
}: {
  state: SessionState;
  signal: SignalBuffer;
  actions: RadioActions;
}) {
  const diagramRef = useRef<HTMLDivElement>(null);
  const [details, setDetails] = useState<SignalDetails | null>(null);
  const selected = details?.selection ?? null;
  const select = (selection: Selection, anchor: HTMLButtonElement) =>
    setDetails((previous) =>
      previous?.selection === selection && previous.anchor === anchor
        ? null
        : { selection, anchor },
    );
  const connected = state.phase === 'connected';
  const playback = playbackView(state);
  const error =
    state.issues.connection ??
    state.issues.control ??
    state.issues.status ??
    state.issues.heartbeat;
  const active = {
    audio: connected && state.audio.at > 0 && state.now - state.audio.at < 3000,
    spectrum: connected && signal.at > 0 && state.now - signal.at < 1200,
    robot: connected && state.telemetryAt > 0 && state.now - state.telemetryAt < 3000,
  };
  const explanation = (selection: Selection): ExplanationTrigger => ({
    expanded: selected === selection,
    onSelect: (anchor) => select(selection, anchor),
  });
  const held = connected && !!state.viewerId && state.room.controller === state.viewerId;
  return (
    <>
      {state.auth === 'required' ? <Login onLogin={actions.login} /> : null}
      <div className="flex flex-col items-start gap-1 rounded-t-xl border border-line bg-panel px-4 py-2 lg:flex-row lg:items-center lg:justify-between">
        <div
          className="flex w-full justify-between gap-3 lg:w-auto lg:gap-5 [&_button]:flex [&_button]:min-h-10 [&_button]:items-center [&_button]:gap-1.5 [&_button]:text-[10px] sm:[&_button]:text-xs [&_button[aria-expanded=true]]:underline [&_button]:underline-offset-4 [&_i]:h-px [&_i]:w-3 [&_i]:bg-current"
          aria-label="Explore signal paths"
        >
          {BRANCHES.map((branch) => (
            <button
              key={branch}
              className={branchStyles[branch].text}
              onClick={(event) => select(branch, event.currentTarget)}
              aria-haspopup="dialog"
              aria-expanded={selected === branch}
              aria-controls={selected === branch ? 'signal-detail' : undefined}
            >
              <i />
              {branch === 'robot'
                ? 'Telemetry & commands'
                : branch === 'audio'
                  ? 'Audio'
                  : 'Spectrum'}
            </button>
          ))}
        </div>
      </div>
      <div
        className="relative isolate grid grid-cols-1 gap-0 border-x border-b border-line bg-surface p-4 sm:p-6 lg:grid-cols-[minmax(205px,1fr)_minmax(145px,0.72fr)_minmax(370px,1.8fr)] lg:gap-6 lg:p-7"
        ref={diagramRef}
      >
        <Wires
          container={diagramRef}
          active={active}
          selected={selected}
          returning={
            state.ack.state === 'pending' ||
            (state.ack.state === 'confirmed' && state.now - state.ack.at < 2000)
          }
        />
        <BoardNode
          led={state.led}
          cpu={state.telemetry?.hardware?.cpuBusyBps}
          {...explanation('board')}
        />
        <SfuNode {...explanation('sfu')} />
        <div className="relative z-1 flex min-w-0 flex-col gap-6 pl-3 sm:pl-4 lg:gap-4 lg:pl-0 before:absolute before:-top-7 before:bottom-8 before:left-0 before:w-px before:bg-line lg:before:hidden">
          <AudioPanel
            phase={state.phase}
            available={state.auth === 'ready' && (state.room.online || state.phase !== 'idle')}
            track={playback.track}
            position={playback.position}
            duration={playback.duration}
            kbps={state.audio.kbps}
            live={active.audio}
            muted={state.muted}
            volume={state.volume}
            audioBlocked={state.audioBlocked}
            onConnect={actions.connect}
            onDisconnect={actions.disconnect}
            onToggleAudio={actions.toggleAudio}
            onVolumeChange={actions.setVolume}
            {...explanation('audio')}
          />
          <SpectrumPanel
            signal={signal}
            live={active.spectrum}
            paused={playback.paused}
            {...explanation('spectrum')}
          />
          <ControlsPanel
            telemetry={state.telemetry}
            trackCount={playback.trackCount}
            paused={playback.paused}
            led={state.led}
            auth={state.auth}
            connected={connected}
            held={held}
            occupied={!!state.room.controller && !held}
            busy={state.busy}
            ack={state.ack}
            live={active.robot}
            onToggleControl={actions.toggleControl}
            onSend={actions.send}
            {...explanation('robot')}
          />
        </div>
      </div>
      <div className="flex items-start gap-2.5 rounded-b-xl border-x border-b border-line bg-panel px-4 py-3 sm:items-center sm:px-5 [&>.status-dot]:mt-1.5 sm:[&>.status-dot]:mt-0 [&>p]:flex-1 [&>p]:text-xs [&>p]:leading-relaxed">
        <span
          className={`status-dot inline-block size-1.5 shrink-0 rounded-full ${connected ? 'bg-spectrum' : 'bg-muted'}`}
        />
        <p role="status" aria-live="polite">
          {state.message}
        </p>
        <span className="hidden font-mono text-[9px] whitespace-nowrap text-muted lg:block">
          {state.received.toLocaleString()} telemetry · {state.spectrumCount.toLocaleString()}{' '}
          spectrum
        </span>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-error" role="alert">
          {error}
        </p>
      ) : null}
      <SignalPopover
        details={details}
        analysis={state.telemetry?.spectrum}
        hardware={state.telemetry?.hardware}
        radioStack={state.telemetry?.stackFree}
        close={() => setDetails(null)}
      />
    </>
  );
}
