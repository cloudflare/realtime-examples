import type { ReactNode } from "react";

import type { GameSnapshot } from "../../shared/protocol";
import type { ControlPhase } from "../control";
import {
  controlLabel,
  mediaLabel,
  runLabel,
  type BusyAction,
  type PhaseState,
  type SignalState,
} from "../presentation";
import type { ViewerPhase } from "../viewer";
import {
  ActionButton,
  StatusRow,
} from "./primitives";

type StatusRailProps = {
  busy: BusyAction | null;
  canStart: boolean;
  canStop: boolean;
  canTakeControl: boolean;
  capturing: boolean;
  controlState: PhaseState<ControlPhase>;
  hasControlSession: boolean;
  hasVideo: boolean;
  onEnableSound: () => void;
  onGameMenu: () => void;
  onRelease: () => void;
  onRetry: () => void;
  onStart: () => void;
  onStop: () => void;
  onTakeControl: () => void;
  pointerLockSupported: boolean;
  signal: SignalState;
  snapshot: GameSnapshot | null;
  soundEnabled: boolean;
  touchOnly: boolean;
  viewerState: PhaseState<ViewerPhase>;
};

export function StatusRail({
  busy,
  canStart,
  canStop,
  canTakeControl,
  capturing,
  controlState,
  hasControlSession,
  hasVideo,
  onEnableSound,
  onGameMenu,
  onRelease,
  onRetry,
  onStart,
  onStop,
  onTakeControl,
  pointerLockSupported,
  signal,
  snapshot,
  soundEnabled,
  touchOnly,
  viewerState,
}: StatusRailProps): ReactNode {
  const hasActions =
    canStart ||
    canStop ||
    canTakeControl ||
    hasControlSession ||
    controlState.phase === "ready" ||
    (!soundEnabled && hasVideo) ||
    viewerState.phase === "error";

  return (
    <aside
      className="border-t border-[#6d6458] bg-charcoal-soft text-bone lg:border-t-0 lg:border-l"
      id="actions"
      aria-label="Status and actions"
    >
      <section className="border-b border-[#5f574d] p-4">
        <div className="flex items-center justify-between">
          <h2 className="m-0 font-display text-xs font-bold uppercase tracking-[0.12em]">
            Status
          </h2>
          <span
            className={`size-2 rounded-full ${signalColor(signal)}`}
            aria-hidden="true"
          />
        </div>
        <dl className="mt-4 mb-0 grid grid-cols-2 gap-x-4 lg:block">
          <StatusRow label="Run" value={runLabel(snapshot)} />
          <StatusRow
            label="Media"
            value={mediaLabel(viewerState.phase)}
          />
          <StatusRow
            label="Audience"
            value={String(snapshot?.viewerCount ?? 0)}
          />
          <StatusRow
            label="Control"
            value={controlLabel(
              snapshot,
              controlState.phase,
              capturing,
            )}
          />
        </dl>
      </section>

      {hasActions ? (
        <section className="grid gap-2 p-4">
          <h2 className="mb-1 font-display text-xs font-bold uppercase tracking-[0.12em]">
            Actions
          </h2>
          {canStart ? (
            <ActionButton
              tone="primary"
              disabled={busy !== null}
              onClick={onStart}
            >
              Start
            </ActionButton>
          ) : null}
          {canTakeControl ? (
            <ActionButton
              disabled={busy !== null}
              onClick={onTakeControl}
              title={controlTitle(touchOnly, pointerLockSupported)}
            >
              Take control
            </ActionButton>
          ) : null}
          {hasControlSession ? (
            <ActionButton disabled={busy !== null} onClick={onRelease}>
              Release control
            </ActionButton>
          ) : null}
          {controlState.phase === "ready" ? (
            <ActionButton disabled={busy !== null} onClick={onGameMenu}>
              Send Esc
            </ActionButton>
          ) : null}
          {!soundEnabled && hasVideo ? (
            <ActionButton disabled={busy !== null} onClick={onEnableSound}>
              Enable sound
            </ActionButton>
          ) : null}
          {viewerState.phase === "error" ? (
            <ActionButton
              tone="quiet"
              disabled={busy !== null}
              onClick={onRetry}
            >
              Retry connection
            </ActionButton>
          ) : null}
          {canStop ? (
            <ActionButton
              tone="danger"
              disabled={busy !== null}
              onClick={onStop}
            >
              Stop game
            </ActionButton>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}

function signalColor(signal: SignalState): string {
  if (signal === "live") return "bg-field-green";
  if (signal === "error") return "bg-field-orange";
  return "bg-[#777066]";
}

function controlTitle(
  touchOnly: boolean,
  pointerLockSupported: boolean,
): string | undefined {
  if (touchOnly) return "Control requires a device with a fine pointer.";
  if (!pointerLockSupported) {
    return "This browser does not support pointer lock.";
  }
  return undefined;
}
