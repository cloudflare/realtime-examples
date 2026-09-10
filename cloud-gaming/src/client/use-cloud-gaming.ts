import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import type { GameSnapshot } from "../shared/protocol";
import { CloudGamingApi } from "./api";
import {
  ControlManager,
  type ControlPhase,
} from "./control";
import {
  formatError,
  INITIAL_CONTROL,
  INITIAL_VIEWER,
  type Notice,
  type PhaseState,
  pollDelay,
} from "./presentation";
import {
  ViewerManager,
  type ViewerPhase,
} from "./viewer";

export type CloudGamingLifecycle = {
  api: CloudGamingApi;
  applySnapshot: (snapshot: GameSnapshot) => void;
  capturing: boolean;
  controlRef: RefObject<ControlManager | null>;
  controlState: PhaseState<ControlPhase>;
  hasVideo: boolean;
  notice: Notice | null;
  pollNow: () => void;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  snapshot: GameSnapshot | null;
  viewerRef: RefObject<ViewerManager | null>;
  viewerState: PhaseState<ViewerPhase>;
};

export function useCloudGaming(
  surfaceRef: RefObject<HTMLDivElement | null>,
  videoRef: RefObject<HTMLVideoElement | null>,
): CloudGamingLifecycle {
  const [api] = useState(() => new CloudGamingApi());
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [viewerState, setViewerState] =
    useState<PhaseState<ViewerPhase>>(INITIAL_VIEWER);
  const [controlState, setControlState] =
    useState<PhaseState<ControlPhase>>(INITIAL_CONTROL);
  const [hasVideo, setHasVideo] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const controlRef = useRef<ControlManager | null>(null);
  const pollNowRef = useRef<(() => void) | null>(null);
  const viewerRef = useRef<ViewerManager | null>(null);

  useEffect(() => {
    const surface = surfaceRef.current;
    const video = videoRef.current;
    if (!surface || !video) return;

    const control = new ControlManager(api, surface, {
      onCaptureChange: setCapturing,
      onError: (context, error) => {
        setNotice({
          message: formatError(context, error),
          source: "control",
        });
      },
      onPhaseChange: (phase, message) => {
        setControlState({ message, phase });
        if (phase === "ready") {
          setNotice((current) =>
            current?.source === "control" ? null : current,
          );
        }
      },
    });
    controlRef.current = control;

    const viewer = new ViewerManager(api, video, {
      onError: (context, error) => {
        setNotice({
          message: formatError(context, error),
          source: "viewer",
        });
      },
      onMediaChange: setHasVideo,
      onPhaseChange: (phase, message) => {
        setViewerState({ message, phase });
        if (phase === "connected") {
          setNotice((current) =>
            current?.source === "viewer" ? null : current,
          );
        }
      },
      onSessionWillClose: async () => {
        controlRef.current?.releaseForViewerChange();
      },
    });
    viewerRef.current = viewer;

    let disposed = false;
    let pollInFlight = false;
    let pollQueued = false;
    let pollTimer: number | null = null;
    let shutDown = false;

    const schedulePoll = (delay: number): void => {
      if (disposed) return;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => {
        pollTimer = null;
        void poll();
      }, delay);
    };

    async function poll(): Promise<void> {
      if (disposed) return;
      if (pollInFlight) {
        pollQueued = true;
        return;
      }

      pollInFlight = true;
      let delay = 3_000;
      try {
        const next = await api.getGame();
        if (disposed) return;
        setSnapshot(next);
        viewer.sync(next);
        setNotice((current) =>
          current?.source === "status" ? null : current,
        );
        delay = pollDelay(next);
      } catch (error) {
        if (!disposed) {
          setNotice({
            message: formatError("Status check", error),
            source: "status",
          });
        }
      } finally {
        pollInFlight = false;
        if (disposed) return;
        if (pollQueued) {
          pollQueued = false;
          schedulePoll(0);
        } else {
          schedulePoll(delay);
        }
      }
    }

    pollNowRef.current = () => {
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
      void poll();
    };

    const shutdown = (): void => {
      if (shutDown) return;
      shutDown = true;
      control.shutdownLocal();
      viewer.shutdownKeepalive();
    };
    const restoreFromCache = (event: PageTransitionEvent): void => {
      if (event.persisted) window.location.reload();
    };

    window.addEventListener("pagehide", shutdown);
    window.addEventListener("pageshow", restoreFromCache);
    void poll();

    return () => {
      disposed = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollNowRef.current = null;
      window.removeEventListener("pagehide", shutdown);
      window.removeEventListener("pageshow", restoreFromCache);
      shutdown();
      controlRef.current = null;
      viewerRef.current = null;
    };
  }, [api, surfaceRef, videoRef]);

  return {
    api,
    applySnapshot(next) {
      setSnapshot(next);
      viewerRef.current?.sync(next);
    },
    capturing,
    controlRef,
    controlState,
    hasVideo,
    notice,
    pollNow() {
      pollNowRef.current?.();
    },
    setNotice,
    snapshot,
    viewerRef,
    viewerState,
  };
}
