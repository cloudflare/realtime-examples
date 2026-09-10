import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { GameStage } from "./components/game-stage";
import { StatusRail } from "./components/status-rail";
import {
  actionLabel,
  formatError,
  signalState,
  type BusyAction,
} from "./presentation";
import { useCloudGaming } from "./use-cloud-gaming";

export function App(): ReactNode {
  const [touchOnly] = useState(
    () =>
      window.matchMedia("(any-pointer: coarse)").matches &&
      !window.matchMedia("(any-pointer: fine)").matches,
  );
  const [pointerLockSupported] = useState(
    () => typeof document.body.requestPointerLock === "function",
  );
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const busyRef = useRef(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const {
    api,
    applySnapshot,
    capturing,
    controlRef,
    controlState,
    hasVideo,
    notice,
    pollNow,
    setNotice,
    snapshot,
    viewerRef,
    viewerState,
  } = useCloudGaming(surfaceRef, videoRef);

  useEffect(() => {
    document.title = "Freedoom Cloud Gaming";
  }, []);

  const runAction = async (
    action: BusyAction,
    work: () => Promise<void>,
  ): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(action);
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setNotice({
        message: formatError(actionLabel(action), error),
        source: "action",
      });
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const start = (): void => {
    void runAction("start", async () => {
      applySnapshot(await api.startGame());
    });
  };

  const stop = (): void => {
    if (
      !window.confirm(
        "Stop Freedoom for every viewer and release all active sessions?",
      )
    ) {
      return;
    }
    void runAction("stop", async () => {
      await controlRef.current?.release().catch(() => {});
      applySnapshot(await api.stopGame());
    });
  };

  const takeControl = (): void => {
    void runAction("take", async () => {
      if (touchOnly || !pointerLockSupported) {
        throw new Error(
          "Keyboard and pointer control is unavailable on this device.",
        );
      }
      const endpoint = viewerRef.current?.controlEndpoint;
      const control = controlRef.current;
      if (!endpoint || !control) {
        throw new Error("A live viewer session is required before control.");
      }
      await control.claim(endpoint);
      pollNow();
    });
  };

  const releaseControl = (): void => {
    void runAction("release", async () => {
      const control = controlRef.current;
      if (!control) throw new Error("No controller assignment is active.");
      await control.release();
      pollNow();
    });
  };

  const openGameMenu = (): void => {
    try {
      const control = controlRef.current;
      if (!control) throw new Error("No controller assignment is active.");
      control.sendGameMenu();
      setNotice(null);
    } catch (error) {
      setNotice({
        message: formatError("Send Esc", error),
        source: "action",
      });
    }
  };

  const enableSound = (): void => {
    void runAction("sound", async () => {
      const video = videoRef.current;
      if (!video) throw new Error("The media surface is unavailable.");
      video.muted = false;
      try {
        await video.play();
        setSoundEnabled(true);
      } catch (error) {
        video.muted = true;
        throw error;
      }
    });
  };

  const retry = (): void => {
    void runAction("retry", async () => {
      const viewer = viewerRef.current;
      if (!viewer) throw new Error("The viewer lifecycle is not ready.");
      viewer.retry();
      applySnapshot(await api.getGame());
    });
  };

  const running = snapshot?.status === "running";
  const controlCanBeClaimed =
    controlState.phase === "idle" || controlState.phase === "error";
  const canTakeControl =
    !touchOnly &&
    pointerLockSupported &&
    running === true &&
    viewerState.phase === "connected" &&
    controlCanBeClaimed &&
    snapshot?.hasController === false;
  const canStart =
    snapshot !== null &&
    (snapshot.status === "stopped" || snapshot.status === "failed") &&
    !snapshot.cleanupPending;
  const canStop =
    snapshot !== null &&
    snapshot.status !== "stopped" &&
    snapshot.status !== "stopping";
  const signal = signalState(viewerState, hasVideo);
  return (
    <>
      <a
        className="fixed top-3 left-3 z-50 -translate-y-24 rounded-[4px] bg-field-orange px-3 py-2 text-sm font-bold text-charcoal focus:translate-y-0 focus:outline-[3px] focus:outline-offset-2 focus:outline-bone"
        href="#actions"
      >
        Skip to actions
      </a>

      <main className="mx-auto mt-4 w-[calc(100%_-_2rem)] max-w-[1180px] max-sm:w-[calc(100%_-_1rem)]">
        <section
          className="grid overflow-hidden rounded-[6px] border border-[#6d6458] bg-bone motion-safe:animate-monitor-in lg:grid-cols-[minmax(0,1fr)_250px]"
          aria-busy={busy !== null}
        >
          <GameStage
            capturing={capturing}
            controlState={controlState}
            hasVideo={hasVideo}
            signal={signal}
            snapshot={snapshot}
            soundEnabled={soundEnabled}
            surfaceRef={surfaceRef}
            videoRef={videoRef}
            viewerState={viewerState}
          />
          <StatusRail
            busy={busy}
            canStart={canStart}
            canStop={canStop}
            canTakeControl={canTakeControl}
            capturing={capturing}
            controlState={controlState}
            hasControlSession={controlRef.current?.hasSession === true}
            hasVideo={hasVideo}
            onEnableSound={enableSound}
            onGameMenu={openGameMenu}
            onRelease={releaseControl}
            onRetry={retry}
            onStart={start}
            onStop={stop}
            onTakeControl={takeControl}
            pointerLockSupported={pointerLockSupported}
            signal={signal}
            snapshot={snapshot}
            soundEnabled={soundEnabled}
            touchOnly={touchOnly}
            viewerState={viewerState}
          />
        </section>

        {notice ? (
          <div
            className="mt-3 flex gap-3 rounded-[4px] border border-[#9d4b2c] bg-[#e5b39a] px-4 py-3 text-xs leading-5 text-[#2c1d18]"
            role="alert"
          >
            <strong className="shrink-0 font-display font-extrabold uppercase tracking-[0.07em]">
              Issue
            </strong>
            <span>{notice.message}</span>
          </div>
        ) : null}
      </main>

    </>
  );
}
