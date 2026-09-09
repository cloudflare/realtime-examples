import type {
  ReactNode,
  RefObject,
} from "react";

import type { GameSnapshot } from "../../shared/protocol";
import type { ControlPhase } from "../control";
import {
  screenMessage,
  type PhaseState,
  type SignalState,
} from "../presentation";
import type { ViewerPhase } from "../viewer";

type GameStageProps = {
  capturing: boolean;
  controlState: PhaseState<ControlPhase>;
  hasVideo: boolean;
  signal: SignalState;
  snapshot: GameSnapshot | null;
  soundEnabled: boolean;
  surfaceRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  viewerState: PhaseState<ViewerPhase>;
};

export function GameStage({
  capturing,
  controlState,
  hasVideo,
  signal,
  snapshot,
  soundEnabled,
  surfaceRef,
  videoRef,
  viewerState,
}: GameStageProps): ReactNode {
  const screen = screenMessage(snapshot, viewerState);

  return (
    <section
      className="min-w-0 p-4 sm:p-6 lg:p-7"
      aria-labelledby="page-title"
    >
      <header className="border-b border-rule pb-4">
        <h1
          className="m-0 font-display text-3xl leading-none font-black tracking-[-0.045em] uppercase sm:text-5xl"
          id="page-title"
        >
          Freedoom
        </h1>
      </header>

      <div
        className="relative mt-4 rounded-[5px] border border-[#201d1a] bg-[#413a32] p-2"
        data-signal={signal}
      >
        <span
          className={`absolute top-[3px] right-2 size-1.5 rounded-full ${signalColor(signal)}`}
          aria-hidden="true"
        />
        <div
          className="relative aspect-[4/3] overflow-hidden rounded-[4px] border border-[#0e0e0d] bg-screen text-bone outline-none focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-field-orange"
          ref={surfaceRef}
          tabIndex={0}
          aria-label="Freedoom game surface"
          aria-describedby="surface-help"
        >
          <video
            className="block size-full bg-[#080808] object-contain"
            ref={videoRef}
            autoPlay
            muted={!soundEnabled}
            playsInline
            aria-label="Freedoom video and audio stream"
          />

          <div
            className={`absolute inset-0 content-center justify-items-center bg-screen p-5 text-center ${
              viewerState.phase === "connected" && hasVideo ? "hidden" : "grid"
            }`}
          >
            <h2 className="m-0 max-w-[18ch] font-display text-2xl leading-none font-black tracking-[-0.02em] uppercase sm:text-4xl">
              {screen.title}
            </h2>
            {screen.copy ? (
              <p className="mt-3 max-w-[32ch] text-xs leading-5 text-bone/60 sm:text-sm">
                {screen.copy}
              </p>
            ) : null}
          </div>

          {controlState.phase === "ready" ? (
            <p className="absolute right-3 bottom-3 left-3 m-0 rounded-[4px] border border-[#72685b] bg-charcoal/95 px-3 py-2 text-center text-xs text-bone">
              {capturing
                ? "Send Esc opens the menu. Physical Escape releases the pointer."
                : "Click the game to capture the pointer. Send Esc opens the menu."}
            </p>
          ) : null}
        </div>
      </div>

      <p className="sr-only" id="surface-help">
        Game control uses pointer lock. Escape releases pointer lock and resets
        held input.
      </p>
    </section>
  );
}

function signalColor(signal: SignalState): string {
  if (signal === "live") return "bg-field-green";
  if (signal === "error") return "bg-field-orange";
  return "bg-[#7a7166]";
}
