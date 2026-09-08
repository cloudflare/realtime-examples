import "./styles.css";

import type {
  JoinResponse,
  ParticipantView,
  RoomSnapshot,
  TrackReference,
} from "../shared/protocol";
import { ApiError, RoomApi } from "./api";
import { SafetyPoller } from "./safety-poller";
import {
  ClientLifecycleController,
  lifecycleControlState,
  type ClientLifecycleTransition,
  type LifecycleTransitionContext,
  retryBounded,
} from "./lifecycle";
import { MediaSessions } from "./media";
import { RoomNotifications } from "./notifications";
import { openAnotherParticipant } from "./open-participant";

const MEDIA_DRAIN_TIMEOUT_MS = 1_000;

type ActiveRoom = {
  api: RoomApi;
  joined: JoinResponse;
  localStream: MediaStream;
  media?: MediaSessions;
};

type BackgroundWork = {
  abortController: AbortController;
  safetyPoller?: SafetyPoller;
  generation: number;
  heartbeatPending: boolean;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  notifications?: RoomNotifications;
  polling: boolean;
  resyncPending: boolean;
  room: ActiveRoom;
};

const roomId = resolveRoomId();
const clientId = sessionValue("video-room-client", () =>
  `c_${crypto.randomUUID().replaceAll("-", "")}`,
);
const elements = {
  copy: required<HTMLButtonElement>("copy-link"),
  displayName: required<HTMLInputElement>("display-name"),
  join: required<HTMLFormElement>("join-form"),
  leave: required<HTMLButtonElement>("leave"),
  lobby: required<HTMLElement>("lobby"),
  lobbyRoomId: required<HTMLElement>("lobby-room-id"),
  creatorActions: required<HTMLElement>("creator-actions"),
  openParticipant: required<HTMLButtonElement>("open-participant"),
  participantCount: required<HTMLElement>("participant-count"),
  room: required<HTMLElement>("room"),
  roomId: required<HTMLElement>("room-id"),
  status: required<HTMLElement>("status"),
  terminate: required<HTMLButtonElement>("terminate"),
  tiles: required<HTMLElement>("tiles"),
};
const joinButton = requireSubmitButton(elements.join);

let activeRoom: ActiveRoom | undefined;
let backgroundWork: BackgroundWork | undefined;
const streams = new Map<string, MediaStream>();
const lifecycle = new ClientLifecycleController(handleLifecycleChange);

elements.roomId.textContent = roomId;
elements.lobbyRoomId.textContent = roomId;
document.title = `${roomId} · Realtime`;
elements.displayName.value = sessionStorage.getItem("video-room-name") ?? "";
elements.join.addEventListener("submit", (event) => {
  event.preventDefault();
  void enterRoom(false);
});
elements.leave.addEventListener("click", () => void leaveRoom());
elements.terminate.addEventListener("click", () => void terminateRoom());
elements.copy.addEventListener("click", async () => {
  const generation = lifecycle.generation;
  const idleAtStart = lifecycle.active === undefined;
  try {
    await navigator.clipboard.writeText(location.href);
    if (
      idleAtStart &&
      lifecycle.isCurrentGeneration(generation) &&
      lifecycle.active === undefined
    ) {
      setStatus("Room link copied.", "ok");
    }
  } catch (error) {
    if (idleAtStart && lifecycle.isCurrentGeneration(generation)) {
      showError(error);
    }
  }
});
elements.openParticipant.addEventListener("click", () => {
  openAnotherParticipant();
});
updateControls();
if (
  sessionStorage.getItem("video-room-joined") === "true" &&
  sessionStorage.getItem("video-room-token") &&
  elements.displayName.value
) {
  void enterRoom(true);
}

async function enterRoom(resume: boolean): Promise<void> {
  try {
    await lifecycle.run(resume ? "resume" : "join", async (transition) => {
      const displayName = elements.displayName.value.trim();
      if (!displayName) {
        transition.commit(() => {
          setStatus("Enter a display name before joining.", "error");
        });
        return;
      }
      await establishRoom(transition, displayName, resume, activeRoom);
    });
  } catch (error) {
    if (isAbortError(error)) return;
    showError(error);
    if (!activeRoom) showLobby();
  }
}

async function establishRoom(
  transition: LifecycleTransitionContext,
  displayName: string,
  resume: boolean,
  previousRoom: ActiveRoom | undefined,
): Promise<void> {
  transition.commit(() => {
    sessionStorage.setItem("video-room-name", displayName);
  });
  const localIdentity = transition.commit(() =>
    sessionValue(
      "video-room-local-identity",
      () => localIdentityFor(displayName, clientId),
    ),
  );
  const pendingMemberToken = transition.commit(() =>
    sessionValue("video-room-pending-token", createCapability),
  );
  let roomStream = previousRoom?.localStream;
  let acquiredStream = false;
  let memberToken =
    previousRoom?.api.memberToken ??
    sessionStorage.getItem("video-room-token") ??
    undefined;
  let reconnectRequestId = lifecycleRequestId();
  let sessionEstablished = false;
  let committed = false;
  let attemptMedia: MediaSessions | undefined;

  try {
    await retryBounded(
      async (attempt) => {
        transition.throwIfSuperseded();
        sessionEstablished = false;
        transition.commit(() => {
          setStatus(
            setupStatus(transition.kind, resume, attempt),
            attempt === 0 && transition.kind !== "reconnect"
              ? "neutral"
              : "warning",
          );
        });

        if (!roomStream) {
          const acquired = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { height: { ideal: 720 }, width: { ideal: 1280 } },
          });
          if (!transition.isCurrent) {
            for (const track of acquired.getTracks()) track.stop();
            transition.throwIfSuperseded();
          }
          roomStream = acquired;
          acquiredStream = true;
        }

        const stream = roomStream;
        transition.throwIfSuperseded();
        const roomApi = new RoomApi(roomId, localIdentity);
        roomApi.memberToken = memberToken;
        const joined = roomApi.memberToken
          ? await reconnectOrJoin(
              roomApi,
              clientId,
              displayName,
              reconnectRequestId,
              pendingMemberToken,
              transition.signal,
            )
          : await roomApi.join(
              clientId,
              displayName,
              pendingMemberToken,
              transition.signal,
            );
        transition.throwIfSuperseded();
        sessionEstablished = true;
        memberToken = joined.memberToken;
        roomApi.memberToken = joined.memberToken;
        if (joined.snapshot.terminated) {
          throw new Error("The room has already been terminated.");
        }
        transition.commit(() => {
          if (previousRoom && activeRoom === previousRoom) {
            previousRoom.api = roomApi;
            previousRoom.joined = joined;
            sessionStorage.removeItem("video-room-pending-token");
            sessionStorage.setItem("video-room-token", joined.memberToken);
            sessionStorage.setItem("video-room-joined", "true");
          }
        });

        const candidate: ActiveRoom = {
          api: roomApi,
          joined,
          localStream: stream,
        };
        const pendingTracks = new Map<
          string,
          { reference: TrackReference; track: MediaStreamTrack }
        >();
        let candidateCommitted = false;
        const candidateMedia = new MediaSessions(
          roomApi,
          joined.generation,
          stream,
          (reference, track) => {
            if (!transition.isCurrent) return;
            if (!candidateCommitted) {
              pendingTracks.set(
                `${reference.participantId}:${reference.kind}`,
                { reference, track },
              );
              return;
            }
            attachRemoteTrack(candidate, reference, track);
          },
          () => {
            if (
              candidateCommitted &&
              transition.isCurrent &&
              activeRoom === candidate
            ) {
              void scheduleReconnect(candidate);
            }
          },
        );
        candidate.media = candidateMedia;
        attemptMedia = candidateMedia;
        const closeCandidate = () => candidateMedia.close();
        transition.signal.addEventListener("abort", closeCandidate, {
          once: true,
        });
        try {
          await candidateMedia.publish();
          transition.throwIfSuperseded();
          await candidateMedia.syncSubscriptions(
            joined.snapshot,
            joined.participantId,
          );
          transition.throwIfSuperseded();
          transition.commit(() => {
            const replaced = activeRoom;
            if (replaced) clearRemoteStreams();
            activeRoom = candidate;
            candidateCommitted = true;
            committed = true;
            attemptMedia = undefined;
            sessionStorage.removeItem("video-room-pending-token");
            sessionStorage.setItem("video-room-token", joined.memberToken);
            sessionStorage.setItem("video-room-joined", "true");
            showRoom(candidate, joined.snapshot);
            for (const { reference, track } of pendingTracks.values()) {
              attachRemoteTrack(candidate, reference, track);
            }
            replaced?.media?.close();
            setStatus("Connected.", "ok");
            updateControls(lifecycle.active);
          });
        } finally {
          transition.signal.removeEventListener("abort", closeCandidate);
          if (!candidateCommitted) candidateMedia.close();
        }
      },
      (error) => error instanceof ApiError && error.retryable,
      async (_error, attempt) => {
        attemptMedia?.close();
        attemptMedia = undefined;
        if (sessionEstablished) reconnectRequestId = lifecycleRequestId();
        await delayWithSignal(250 * 2 ** attempt, transition.signal);
      },
    );
  } finally {
    attemptMedia?.close();
    if (acquiredStream && !committed && roomStream) {
      for (const track of roomStream.getTracks()) track.stop();
    }
  }
}

async function reconnectOrJoin(
  roomApi: RoomApi,
  currentClientId: string,
  displayName: string,
  requestId: string,
  pendingMemberToken: string,
  signal: AbortSignal,
): Promise<JoinResponse> {
  try {
    return await roomApi.reconnect(
      currentClientId,
      displayName,
      requestId,
      signal,
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code === "member_token_invalid"
    ) {
      roomApi.memberToken = undefined;
      return roomApi.join(
        currentClientId,
        displayName,
        pendingMemberToken,
        signal,
      );
    }
    throw error;
  }
}

async function scheduleReconnect(room = activeRoom): Promise<void> {
  if (
    !room ||
    activeRoom !== room ||
    lifecycle.active !== undefined
  ) {
    return;
  }
  try {
    await lifecycle.run("reconnect", async (transition) => {
      transition.throwIfSuperseded();
      if (activeRoom !== room) return;
      const replacedMedia = room.media;
      transition.commit(() => {
        room.media = undefined;
      });
      await replacedMedia?.closeAndWait(MEDIA_DRAIN_TIMEOUT_MS);
      transition.throwIfSuperseded();
      await establishRoom(
        transition,
        elements.displayName.value.trim(),
        true,
        room,
      );
    });
  } catch (error) {
    if (isAbortError(error)) return;
    if (activeRoom === room) showError(error);
  }
}

async function leaveRoom(): Promise<void> {
  const room = activeRoom;
  if (!room) return;
  await runTerminalTransition(
    "leave",
    room,
    "Leaving...",
    "You left the room.",
    (signal) => room.api.leave(signal),
  );
}

async function terminateRoom(): Promise<void> {
  if (!confirm("Terminate this room for every participant?")) return;
  const room = activeRoom;
  if (!room) return;
  await runTerminalTransition(
    "terminate",
    room,
    "Terminating the room...",
    "Room terminated.",
    (signal) => room.api.terminate(signal),
  );
}

async function runTerminalTransition(
  kind: Extract<ClientLifecycleTransition, "leave" | "terminate">,
  room: ActiveRoom,
  pendingStatus: string,
  successStatus: string,
  request: (signal: AbortSignal) => Promise<RoomSnapshot>,
): Promise<void> {
  try {
    await lifecycle.run(kind, async (transition) => {
      transition.throwIfSuperseded();
      if (activeRoom !== room) return;
      const mediaToClose = room.media;
      transition.commit(() => {
        room.media = undefined;
        setStatus(pendingStatus);
      });
      await mediaToClose?.closeAndWait(MEDIA_DRAIN_TIMEOUT_MS);
      transition.throwIfSuperseded();
      await request(transition.signal);
      transition.commit(() => {
        resetLocalSession(room);
        setStatus(successStatus, "ok");
      });
    });
  } catch (error) {
    if (isAbortError(error)) return;
    if (activeRoom === room) showError(error);
  }
}

async function observeTermination(room: ActiveRoom): Promise<void> {
  try {
    await lifecycle.run("terminate", async (transition) => {
      transition.throwIfSuperseded();
      if (activeRoom !== room) return;
      const mediaToClose = room.media;
      transition.commit(() => {
        room.media = undefined;
      });
      await mediaToClose?.closeAndWait(MEDIA_DRAIN_TIMEOUT_MS);
      transition.commit(() => {
        resetLocalSession(room);
        setStatus("The room creator terminated this room.", "error");
      });
    });
  } catch (error) {
    if (!isAbortError(error) && activeRoom === room) showError(error);
  }
}

function showRoom(room: ActiveRoom, snapshot: RoomSnapshot): void {
  if (activeRoom !== room) return;
  if (snapshot.terminated) {
    void observeTermination(room);
    return;
  }
  elements.lobby.hidden = true;
  elements.room.hidden = false;
  elements.participantCount.textContent = `${snapshot.participants.length} ${
    snapshot.participants.length === 1 ? "participant" : "participants"
  }`;
  elements.creatorActions.hidden =
    snapshot.creatorParticipantId !== room.joined.participantId;
  renderParticipants(
    snapshot.participants,
    room.joined.participantId,
    room.localStream,
  );
  updateControls(lifecycle.active);
}

function showLobby(): void {
  elements.room.hidden = true;
  elements.lobby.hidden = false;
}

function renderParticipants(
  participants: ParticipantView[],
  selfId: string,
  localStream: MediaStream,
): void {
  const activeIds = new Set(participants.map((participant) => participant.id));
  for (const tile of elements.tiles.querySelectorAll<HTMLElement>(
    "[data-participant]",
  )) {
    const id = tile.dataset.participant;
    if (id && !activeIds.has(id)) {
      streams.delete(id);
      tile.remove();
    }
  }
  for (const participant of participants) {
    let tile = elements.tiles.querySelector<HTMLElement>(
      `[data-participant="${participant.id}"]`,
    );
    if (!tile) {
      tile = document.createElement("figure");
      tile.className = "video-tile";
      tile.dataset.participant = participant.id;
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = participant.id === selfId;
      const label = document.createElement("figcaption");
      label.className = "tile-label";
      tile.appendChild(video);
      tile.appendChild(label);
      elements.tiles.appendChild(tile);
    }
    const video = tile.querySelector("video")!;
    const label = tile.querySelector<HTMLElement>(".tile-label")!;
    label.textContent =
      participant.id === selfId
        ? `${participant.displayName} (you)`
        : participant.displayName;
    if (participant.id === selfId) {
      video.srcObject = localStream;
    } else {
      const stream = streams.get(participant.id);
      if (stream && video.srcObject !== stream) video.srcObject = stream;
    }
  }
}

function attachRemoteTrack(
  room: ActiveRoom,
  reference: TrackReference,
  track: MediaStreamTrack,
): void {
  if (activeRoom !== room || track.readyState === "ended") return;
  let stream = streams.get(reference.participantId);
  if (!stream) {
    stream = new MediaStream();
    streams.set(reference.participantId, stream);
  }
  for (const existing of stream.getTracks()) {
    if (existing.kind === track.kind || existing.readyState === "ended") {
      stream.removeTrack(existing);
    }
  }
  stream.addTrack(track);
  const video = elements.tiles.querySelector<HTMLVideoElement>(
    `[data-participant="${reference.participantId}"] video`,
  );
  if (video) video.srcObject = stream;
}

function clearRemoteStreams(): void {
  streams.clear();
  for (const video of elements.tiles.querySelectorAll<HTMLVideoElement>(
    "video:not([muted])",
  )) {
    video.srcObject = null;
  }
}

function handleLifecycleChange(
  transition: ClientLifecycleTransition | undefined,
): void {
  if (transition) stopBackgroundWork();
  updateControls(transition);
  if (!transition && activeRoom) startBackgroundWork(activeRoom);
}

function startBackgroundWork(room: ActiveRoom): void {
  if (
    activeRoom !== room ||
    lifecycle.active !== undefined
  ) {
    return;
  }
  stopBackgroundWork();
  const work: BackgroundWork = {
    abortController: new AbortController(),
    generation: lifecycle.generation,
    heartbeatPending: false,
    polling: false,
    resyncPending: false,
    room,
  };
  work.safetyPoller = new SafetyPoller(() => poll(work));
  work.notifications = new RoomNotifications(room.api, () => poll(work));
  work.heartbeatTimer = setInterval(() => {
    void heartbeat(work);
  }, 10_000);
  backgroundWork = work;
  work.safetyPoller.start();
  work.notifications.start();
}

function stopBackgroundWork(): void {
  const work = backgroundWork;
  backgroundWork = undefined;
  if (!work) return;
  work.abortController.abort(
    new DOMException("Room background work stopped.", "AbortError"),
  );
  work.safetyPoller?.stop();
  work.notifications?.stop();
  if (work.heartbeatTimer) clearInterval(work.heartbeatTimer);
}

async function poll(work: BackgroundWork): Promise<void> {
  if (!isCurrentBackgroundWork(work)) return;
  if (work.polling) {
    work.resyncPending = true;
    return;
  }
  work.polling = true;
  try {
    do {
      work.resyncPending = false;
      const snapshot = await work.room.api.snapshot(
        work.abortController.signal,
      );
      if (!isCurrentBackgroundWork(work)) return;
      if (snapshot.terminated) {
        void observeTermination(work.room);
        return;
      }
      showRoom(work.room, snapshot);
      const media = work.room.media;
      await media?.syncSubscriptions(
        snapshot,
        work.room.joined.participantId,
      );
    } while (work.resyncPending && isCurrentBackgroundWork(work));
  } catch (error) {
    if (!isCurrentBackgroundWork(work) || isAbortError(error)) return;
    showError(error);
    if (error instanceof ApiError && error.retryable) {
      void scheduleReconnect(work.room);
    }
  } finally {
    work.polling = false;
    if (work.resyncPending && isCurrentBackgroundWork(work)) {
      work.resyncPending = false;
      void poll(work);
    }
  }
}

async function heartbeat(work: BackgroundWork): Promise<void> {
  if (!isCurrentBackgroundWork(work) || work.heartbeatPending) return;
  work.heartbeatPending = true;
  try {
    const snapshot = await work.room.api.heartbeat(
      work.abortController.signal,
    );
    if (!isCurrentBackgroundWork(work)) return;
    if (snapshot.terminated) void observeTermination(work.room);
  } catch (error) {
    if (!isCurrentBackgroundWork(work) || isAbortError(error)) return;
    showError(error);
    if (error instanceof ApiError && error.retryable) {
      void scheduleReconnect(work.room);
    }
  } finally {
    work.heartbeatPending = false;
  }
}

function isCurrentBackgroundWork(work: BackgroundWork): boolean {
  return (
    backgroundWork === work &&
    activeRoom === work.room &&
    lifecycle.active === undefined &&
    lifecycle.isCurrentGeneration(work.generation) &&
    !work.abortController.signal.aborted
  );
}

function resetLocalSession(room: ActiveRoom): void {
  if (activeRoom !== room) return;
  stopBackgroundWork();
  activeRoom = undefined;
  room.media?.close();
  sessionStorage.removeItem("video-room-token");
  sessionStorage.removeItem("video-room-pending-token");
  sessionStorage.removeItem("video-room-joined");
  for (const track of room.localStream.getTracks()) track.stop();
  streams.clear();
  elements.tiles.replaceChildren();
  showLobby();
  updateControls(lifecycle.active);
}

function updateControls(
  transition: ClientLifecycleTransition | undefined = lifecycle.active,
): void {
  const controls = lifecycleControlState(transition, Boolean(activeRoom));
  elements.displayName.disabled = controls.displayNameDisabled;
  joinButton.disabled = controls.joinDisabled;
  elements.leave.disabled = controls.leaveDisabled;
  elements.terminate.disabled = controls.terminateDisabled;
  elements.join.setAttribute(
    "aria-busy",
    String(transition === "join" || transition === "resume"),
  );
  elements.room.setAttribute(
    "aria-busy",
    String(
      transition === "reconnect" ||
        transition === "leave" ||
        transition === "terminate",
    ),
  );
}

function showError(error: unknown): void {
  if (error instanceof ApiError) {
    const suffix = error.requestId ? ` Request ID: ${error.requestId}.` : "";
    setStatus(`${error.message}${suffix}`, "error");
    return;
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    setStatus(
      "Camera or microphone permission was denied. Allow access and try again.",
      "error",
    );
    return;
  }
  setStatus(
    error instanceof Error ? error.message : "The room operation failed.",
    "error",
  );
}

function setStatus(
  message: string,
  tone: "error" | "ok" | "warning" | "neutral" = "neutral",
): void {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function setupStatus(
  transition: ClientLifecycleTransition,
  resume: boolean,
  attempt: number,
): string {
  if (attempt > 0) return `Retrying room setup (${attempt + 1}/3)...`;
  if (transition === "reconnect") {
    return "Connection interrupted. Reconnecting...";
  }
  return resume
    ? "Rejoining the room..."
    : "Requesting camera and microphone...";
}

function resolveRoomId(): string {
  const match = /^\/rooms\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(
    location.pathname,
  );
  if (match?.[1]) return match[1];
  const generated = `room-${crypto.randomUUID().slice(0, 8)}`;
  history.replaceState(null, "", `/rooms/${generated}`);
  return generated;
}

function localIdentityFor(displayName: string, id: string): string {
  const name =
    displayName
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "local";
  return `${name}-${id.slice(-8)}`;
}

function lifecycleRequestId(): string {
  return `l_${crypto.randomUUID().replaceAll("-", "")}`;
}

function createCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function sessionValue(key: string, create: () => string): string {
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const value = create();
  sessionStorage.setItem(key, value);
  return value;
}

function required<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}.`);
  return element as ElementType;
}

function requireSubmitButton(form: HTMLFormElement): HTMLButtonElement {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button) throw new Error('Missing button[type="submit"].');
  return button;
}

function delayWithSignal(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    const aborted = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
