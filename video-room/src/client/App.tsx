import { useEffect, useRef, useSyncExternalStore } from "react";
import { lifecycleControlState } from "./lifecycle";
import { openAnotherParticipant } from "./open-participant";
import type {
  JoinedRoomView,
  RoomController,
  RoomViewState,
} from "./room-controller";

export function App({ controller }: { controller: RoomController }) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const controls = lifecycleControlState(state.transition, Boolean(state.room));
  return (
    <>
      <a
        className="fixed top-3 left-3 z-10 -translate-y-20 rounded-lg bg-stone-900 px-4 py-3 text-sm font-medium text-white focus-visible:translate-y-0"
        href="#main-content"
      >
        Skip to room workspace
      </a>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <RoomHeader
          roomId={controller.roomId}
          onCopyLink={controller.copyLink}
        />
        <main
          id="main-content"
          className="group overflow-hidden rounded-b-xl border-x border-b border-stone-200 bg-white shadow-sm"
          tabIndex={-1}
        >
          {state.room ? (
            <Room
              room={state.room}
              busy={controls.roomBusy}
              leaveDisabled={controls.leaveDisabled}
              terminateDisabled={controls.terminateDisabled}
              onLeave={controller.leave}
              onTerminate={controller.terminate}
            />
          ) : (
            <Lobby
              roomId={controller.roomId}
              displayName={state.displayName}
              busy={controls.joinBusy}
              nameDisabled={controls.displayNameDisabled}
              joinDisabled={controls.joinDisabled}
              onNameChange={controller.setDisplayName}
              onJoin={controller.join}
            />
          )}
          <StatusBar {...state.status} />
        </main>
      </div>
    </>
  );
}

function RoomHeader({
  roomId,
  onCopyLink,
}: {
  roomId: string;
  onCopyLink: () => Promise<void>;
}) {
  return (
    <header className="grid gap-4 rounded-t-xl border border-stone-200 bg-white p-4 sm:flex sm:items-center sm:justify-between sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <a
          className="flex shrink-0 items-center gap-2.5 text-sm font-semibold hover:text-orange-700"
          href="/"
          title="Create a new room"
        >
          <span
            className="flex size-9 items-center justify-center rounded-lg bg-orange-50 text-orange-700"
            aria-hidden="true"
          >
            <svg
              className="size-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="6" width="12" height="12" rx="3" />
              <path d="m15 10 6-3v10l-6-3" />
            </svg>
          </span>
          Realtime
        </a>
        <span className="text-stone-300" aria-hidden="true">
          /
        </span>
        <strong
          id="room-id"
          className="truncate font-mono text-xs font-normal text-stone-600"
        >
          {roomId}
        </strong>
      </div>
      <div
        className="flex flex-wrap items-center gap-2 sm:shrink-0"
        role="group"
        aria-label="Room utilities"
      >
        <button
          id="copy-link"
          onClick={() => void onCopyLink()}
          className="inline-flex min-h-11 cursor-pointer grow items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 motion-reduce:transition-none sm:grow-0"
          type="button"
        >
          <svg
            className="size-4 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
          </svg>
          Copy link
        </button>
        <button
          id="open-participant"
          onClick={() => openAnotherParticipant()}
          className="inline-flex min-h-11 cursor-pointer grow items-center justify-center rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium shadow-xs transition-colors hover:bg-stone-50 motion-reduce:transition-none sm:grow-0"
          type="button"
        >
          Open another participant
        </button>
      </div>
    </header>
  );
}

function Lobby({
  roomId,
  displayName,
  busy,
  nameDisabled,
  joinDisabled,
  onNameChange,
  onJoin,
}: {
  roomId: string;
  displayName: string;
  busy: boolean;
  nameDisabled: boolean;
  joinDisabled: boolean;
  onNameChange: (name: string) => void;
  onJoin: () => Promise<void>;
}) {
  return (
    <section
      id="lobby"
      className="px-5 py-10 sm:px-10 sm:py-14"
      aria-labelledby="lobby-title"
      aria-describedby="status"
    >
      <div className="max-w-xl">
        <h1
          id="lobby-title"
          className="text-2xl leading-tight font-semibold tracking-tight sm:text-3xl"
        >
          Join{" "}
          <span id="lobby-room-id" className="wrap-anywhere">
            {roomId}
          </span>
        </h1>
        <p className="mt-3 text-sm leading-6 text-stone-600 sm:text-base">
          Enter your name, then allow camera and microphone access.
        </p>

        <form
          id="join-form"
          className="mt-8"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void onJoin();
          }}
        >
          <label htmlFor="display-name" className="block text-sm font-medium">
            Display name
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <input
              id="display-name"
              value={displayName}
              onChange={(event) => onNameChange(event.currentTarget.value)}
              disabled={nameDisabled}
              className="min-h-12 w-full min-w-0 rounded-lg border border-stone-500 bg-white px-3.5 py-2.5 text-base shadow-xs placeholder:text-stone-500 enabled:hover:border-stone-600 disabled:cursor-not-allowed disabled:border-stone-300 disabled:bg-stone-100 disabled:text-stone-500"
              name="display-name"
              maxLength={48}
              autoComplete="name"
              placeholder="Your name"
              required
            />
            <button
              className="inline-flex min-h-12 cursor-pointer shrink-0 items-center justify-center gap-2 rounded-lg bg-orange-700 px-5 py-3 text-sm font-semibold text-white shadow-xs transition-colors enabled:hover:bg-orange-800 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
              type="submit"
              disabled={joinDisabled}
            >
              Join room
              <svg
                className="size-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 12h14m-5-5 5 5-5 5" />
              </svg>
            </button>
          </div>
        </form>

        <p className="mt-6 rounded-lg bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-600">
          Trying this on your own? Use{" "}
          <strong className="font-medium text-stone-900">
            Open another participant
          </strong>{" "}
          to create a fresh tab. Duplicating this tab can reuse your identity.
        </p>
      </div>
    </section>
  );
}

function Room({
  room,
  busy,
  leaveDisabled,
  terminateDisabled,
  onLeave,
  onTerminate,
}: {
  room: JoinedRoomView;
  busy: boolean;
  leaveDisabled: boolean;
  terminateDisabled: boolean;
  onLeave: () => Promise<void>;
  onTerminate: () => Promise<void>;
}) {
  return (
    <section
      id="room"
      className="p-3 sm:p-5"
      aria-busy={busy}
      aria-label="Video room"
      aria-describedby="status"
    >
      <div className="rounded-xl bg-stone-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-stone-200">In this room</h2>
          <p
            id="participant-count"
            className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-xs text-stone-200"
          >
            {room.snapshot.participants.length}{" "}
            {room.snapshot.participants.length === 1
              ? "participant"
              : "participants"}
          </p>
        </div>
        <div
          id="tiles"
          className="grid grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] gap-3"
          aria-live="polite"
        >
          {room.snapshot.participants.map((participant) => (
            <ParticipantTile
              key={participant.id}
              id={participant.id}
              name={participant.displayName}
              self={participant.id === room.selfId}
              stream={
                participant.id === room.selfId
                  ? room.localStream
                  : room.remoteStreams.get(participant.id)
              }
            />
          ))}
        </div>
      </div>

      <div
        className="mt-4 flex flex-wrap items-center justify-end gap-2"
        role="group"
        aria-label="Room controls"
      >
        <button
          id="leave"
          disabled={leaveDisabled}
          onClick={() => void onLeave()}
          className="inline-flex min-h-11 cursor-pointer grow items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium shadow-xs transition-colors enabled:hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:grow-0"
          type="button"
        >
          Leave
        </button>
        <div
          id="creator-actions"
          className="grow sm:grow-0"
          hidden={room.snapshot.creatorParticipantId !== room.selfId}
        >
          <button
            id="terminate"
            disabled={terminateDisabled}
            onClick={() => void onTerminate()}
            className="inline-flex min-h-11 cursor-pointer w-full items-center justify-center rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors enabled:hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            type="button"
          >
            Terminate room
          </button>
        </div>
      </div>
    </section>
  );
}

function ParticipantTile({
  id,
  name,
  self,
  stream,
}: {
  id: string;
  name: string;
  self: boolean;
  stream?: MediaStream;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream ?? null;
    return () => {
      // A view releases its attachment; the room controller owns the tracks.
      video.srcObject = null;
    };
  }, [stream]);
  return (
    <figure
      className="video-tile relative overflow-hidden rounded-lg border border-white/10 bg-stone-800"
      data-participant={id}
    >
      <video
        ref={ref}
        className={`aspect-video w-full bg-stone-800 object-cover ${self ? "-scale-x-100" : ""}`}
        autoPlay
        playsInline
        muted={self}
      />
      <figcaption className="tile-label absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] truncate rounded-md bg-stone-950/80 px-2.5 py-1.5 text-xs font-medium text-white">
        {self ? `${name} (you)` : name}
      </figcaption>
    </figure>
  );
}

function StatusBar({ message, tone }: RoomViewState["status"]) {
  return (
    <div className="flex min-h-12 items-start gap-2.5 border-t border-stone-200 bg-stone-50 px-5 py-3 text-sm sm:px-6">
      <span
        className="mt-1.5 size-2 shrink-0 rounded-full bg-stone-400 group-has-[[data-tone=error]]:bg-red-700 group-has-[[data-tone=ok]]:bg-emerald-700 group-has-[[data-tone=warning]]:bg-amber-700 motion-safe:group-has-[[aria-busy=true]]:animate-pulse"
        aria-hidden="true"
      ></span>
      <span className="font-medium text-stone-700" aria-hidden="true">
        Status
      </span>
      <p
        id="status"
        className="min-w-0 wrap-anywhere text-stone-600 data-[tone=error]:font-medium data-[tone=error]:text-red-700 data-[tone=ok]:text-emerald-700 data-[tone=warning]:text-amber-700"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-tone={tone}
      >
        {message}
      </p>
    </div>
  );
}
