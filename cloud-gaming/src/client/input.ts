const FRAME_HEADER_BYTES = 17;
const POINTER_BUFFER_HIGH_WATER = 64 * 1024;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

const INPUT_TYPE = {
  button: 2,
  key: 1,
  motion: 3,
  ownership: 6,
  reset: 5,
  wheel: 4,
} as const;

const X11_KEYCODE: Readonly<Record<string, number>> = {
  AltLeft: 64,
  AltRight: 108,
  ArrowDown: 116,
  ArrowLeft: 113,
  ArrowRight: 114,
  ArrowUp: 111,
  Backspace: 22,
  Comma: 59,
  ControlLeft: 37,
  ControlRight: 105,
  Digit1: 10,
  Digit2: 11,
  Digit3: 12,
  Digit4: 13,
  Digit5: 14,
  Digit6: 15,
  Digit7: 16,
  Enter: 36,
  Escape: 9,
  KeyA: 38,
  KeyC: 54,
  KeyD: 40,
  KeyE: 26,
  KeyF: 41,
  KeyQ: 24,
  KeyR: 27,
  KeyS: 39,
  KeyW: 25,
  KeyX: 53,
  KeyZ: 52,
  Period: 60,
  ShiftLeft: 50,
  ShiftRight: 62,
  Space: 65,
  Tab: 23,
};

type KeyInput = {
  keycode: number;
  pressed: boolean;
  type: "key";
};

type ButtonInput = {
  button: number;
  pressed: boolean;
  type: "button";
};

type MotionInput = {
  deltaX: number;
  deltaY: number;
  type: "motion";
};

type WheelInput = {
  deltaY: number;
  type: "wheel";
};

type ResetInput = {
  type: "reset";
};

type OwnershipInput = {
  active: boolean;
  type: "ownership";
};

export type InputFrame =
  | ButtonInput
  | KeyInput
  | MotionInput
  | OwnershipInput
  | ResetInput
  | WheelInput;

type ReliableInput = Exclude<InputFrame, MotionInput>;

type BrowserInputOptions = {
  generation: number;
  onCaptureChange: (capturing: boolean) => void;
  onError: (error: unknown) => void;
  pointer: RTCDataChannel;
  reliable: RTCDataChannel;
  surface: HTMLElement;
};

export class BrowserInput {
  private active = false;
  private errorQueued = false;
  private heldButtons = new Set<number>();
  private heldKeys = new Map<string, number>();
  private ownsPointer = false;
  private pendingX = 0;
  private pendingY = 0;
  private pointerFrame: number | null = null;
  private pointerSequence = 0n;
  private reliableSequence = 0n;

  constructor(private readonly options: BrowserInputOptions) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.options.surface.classList.add("cursor-crosshair");
    this.options.surface.addEventListener("click", this.onSurfaceClick);
    this.options.surface.addEventListener("contextmenu", this.onContextMenu);
    this.options.surface.addEventListener("wheel", this.onWheel, {
      passive: false,
    });
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("mousedown", this.onMouseDown);
    document.addEventListener("mouseup", this.onMouseUp);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("blur", this.onWindowBlur);
  }

  dispose(sendReset = true): void {
    if (!this.active) return;
    this.resetBrowserInput(sendReset, true, true);
    this.active = false;
    this.options.surface.classList.remove("cursor-crosshair");
    this.options.surface.removeEventListener("click", this.onSurfaceClick);
    this.options.surface.removeEventListener("contextmenu", this.onContextMenu);
    this.options.surface.removeEventListener("wheel", this.onWheel);
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("mousedown", this.onMouseDown);
    document.removeEventListener("mouseup", this.onMouseUp);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("blur", this.onWindowBlur);
  }

  sendGameMenu(): boolean {
    if (!this.active) return false;
    const keycode = X11_KEYCODE.Escape;
    if (keycode === undefined) return false;
    return (
      this.sendReliable({ keycode, pressed: true, type: "key" }) &&
      this.sendReliable({ keycode, pressed: false, type: "key" })
    );
  }

  private readonly onSurfaceClick = (): void => {
    if (
      !this.active ||
      document.pointerLockElement === this.options.surface
    ) {
      return;
    }
    this.options.surface.focus();
    try {
      void Promise.resolve(this.options.surface.requestPointerLock()).catch(
        (error) => {
          this.queueError(error);
        },
      );
    } catch (error) {
      this.queueError(error);
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.active) event.preventDefault();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.ownsPointer) return;
    const keycode = X11_KEYCODE[event.code];
    if (keycode === undefined) return;

    event.preventDefault();
    if (event.repeat || this.heldKeys.has(event.code)) return;
    if (this.sendReliable({ keycode, pressed: true, type: "key" })) {
      this.heldKeys.set(event.code, keycode);
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (!this.ownsPointer) return;
    const keycode = this.heldKeys.get(event.code);
    if (keycode === undefined) return;

    event.preventDefault();
    this.heldKeys.delete(event.code);
    this.sendReliable({ keycode, pressed: false, type: "key" });
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (!this.ownsPointer) return;
    const button = mouseButton(event.button);
    if (button === null) return;

    event.preventDefault();
    if (
      !this.heldButtons.has(button) &&
      this.sendReliable({ button, pressed: true, type: "button" })
    ) {
      this.heldButtons.add(button);
    }
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (!this.ownsPointer) return;
    const button = mouseButton(event.button);
    if (button === null || !this.heldButtons.has(button)) return;

    event.preventDefault();
    this.heldButtons.delete(button);
    this.sendReliable({ button, pressed: false, type: "button" });
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.ownsPointer || event.deltaY === 0) return;

    const amount = Math.min(
      9,
      Math.max(1, Math.round(Math.abs(event.deltaY) / 100)),
    );
    const deltaY = event.deltaY < 0 ? amount : -amount;
    if (this.sendReliable({ deltaY, type: "wheel" })) {
      event.preventDefault();
    }
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.ownsPointer) return;
    this.pendingX += event.movementX;
    this.pendingY += event.movementY;
    if (this.pointerFrame === null) {
      this.pointerFrame = window.requestAnimationFrame(
        this.flushPointerMovement,
      );
    }
  };

  private readonly flushPointerMovement = (): void => {
    this.pointerFrame = null;
    const deltaX = clampInt16(Math.trunc(this.pendingX));
    const deltaY = clampInt16(Math.trunc(this.pendingY));
    this.pendingX = 0;
    this.pendingY = 0;

    if (
      !this.ownsPointer ||
      (deltaX === 0 && deltaY === 0) ||
      this.options.pointer.readyState !== "open" ||
      this.options.pointer.bufferedAmount > POINTER_BUFFER_HIGH_WATER
    ) {
      return;
    }

    this.pointerSequence = nextSequence(this.pointerSequence);
    try {
      this.options.pointer.send(
        encodeInputFrame(
          { deltaX, deltaY, type: "motion" },
          this.options.generation,
          this.pointerSequence,
        ),
      );
    } catch (error) {
      this.queueError(error);
    }
  };

  private readonly onPointerLockChange = (): void => {
    const captured = document.pointerLockElement === this.options.surface;
    if (captured) {
      this.ownsPointer = true;
      this.options.surface.focus();
      if (
        !this.sendReliable({
          active: true,
          type: "ownership",
        })
      ) {
        this.resetBrowserInput(false, true, true);
        return;
      }
      this.options.onCaptureChange(true);
      return;
    }

    if (this.ownsPointer) {
      this.resetBrowserInput(true, false, true);
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.resetBrowserInput(true, true, true);
    }
  };

  private readonly onWindowBlur = (): void => {
    this.resetBrowserInput(true, true, true);
  };

  private resetBrowserInput(
    sendReset: boolean,
    unlock: boolean,
    suppressSendErrors: boolean,
  ): void {
    const owned = this.ownsPointer;
    this.ownsPointer = false;
    this.heldButtons.clear();
    this.heldKeys.clear();
    this.pendingX = 0;
    this.pendingY = 0;
    if (this.pointerFrame !== null) {
      window.cancelAnimationFrame(this.pointerFrame);
      this.pointerFrame = null;
    }

    if (sendReset) {
      if (owned) {
        this.sendReliable(
          { active: false, type: "ownership" },
          suppressSendErrors,
        );
      }
      this.sendReliable({ type: "reset" }, suppressSendErrors);
    }

    if (unlock && document.pointerLockElement === this.options.surface) {
      document.exitPointerLock();
    }
    this.options.onCaptureChange(false);
  }

  private sendReliable(
    input: ReliableInput,
    suppressError = false,
  ): boolean {
    if (this.options.reliable.readyState !== "open") return false;

    this.reliableSequence = nextSequence(this.reliableSequence);
    try {
      this.options.reliable.send(
        encodeInputFrame(
          input,
          this.options.generation,
          this.reliableSequence,
        ),
      );
      return true;
    } catch (error) {
      if (!suppressError) this.queueError(error);
      return false;
    }
  }

  private queueError(error: unknown): void {
    if (this.errorQueued) return;
    this.errorQueued = true;
    queueMicrotask(() => {
      this.errorQueued = false;
      this.options.onError(error);
    });
  }
}

export function encodeInputFrame(
  input: InputFrame,
  generation: number,
  sequence: bigint,
): ArrayBuffer {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("The controller generation is not a supported integer.");
  }
  if (sequence < 1n || sequence > UINT64_MAX) {
    throw new Error("The input sequence is outside the uint64 range.");
  }

  const payloadBytes = payloadLength(input);
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + payloadBytes);
  const view = new DataView(buffer);
  view.setUint8(0, INPUT_TYPE[input.type]);
  writeUint64LittleEndian(view, 1, BigInt(generation));
  writeUint64LittleEndian(view, 9, sequence);

  switch (input.type) {
    case "key":
      view.setUint8(17, input.keycode);
      view.setUint8(18, input.pressed ? 1 : 0);
      break;
    case "button":
      view.setUint8(17, input.button);
      view.setUint8(18, input.pressed ? 1 : 0);
      break;
    case "motion":
      view.setInt16(17, input.deltaX, true);
      view.setInt16(19, input.deltaY, true);
      break;
    case "wheel":
      view.setInt8(17, input.deltaY);
      break;
    case "ownership":
      view.setUint8(17, input.active ? 1 : 0);
      break;
    case "reset":
      break;
  }
  return buffer;
}

function payloadLength(input: InputFrame): number {
  switch (input.type) {
    case "key":
    case "button":
      return 2;
    case "motion":
      return 4;
    case "wheel":
    case "ownership":
      return 1;
    case "reset":
      return 0;
  }
}

function writeUint64LittleEndian(
  view: DataView,
  offset: number,
  value: bigint,
): void {
  if (value < 0n || value > UINT64_MAX) {
    throw new Error("The uint64 value is outside the supported range.");
  }
  view.setUint32(offset, Number(value & 0xffff_ffffn), true);
  view.setUint32(offset + 4, Number(value >> 32n), true);
}

function nextSequence(current: bigint): bigint {
  if (current >= UINT64_MAX) {
    throw new Error("The input sequence was exhausted.");
  }
  return current + 1n;
}

function mouseButton(button: number): number | null {
  switch (button) {
    case 0:
      return 1;
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 8;
    case 4:
      return 9;
    default:
      return null;
  }
}

function clampInt16(value: number): number {
  return Math.max(-32_768, Math.min(32_767, value));
}
