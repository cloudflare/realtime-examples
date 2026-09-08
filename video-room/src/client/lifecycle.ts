export type ClientLifecycleTransition =
  | "join"
  | "resume"
  | "reconnect"
  | "leave"
  | "terminate";

export type LifecycleControlState = {
  displayNameDisabled: boolean;
  joinDisabled: boolean;
  leaveDisabled: boolean;
  terminateDisabled: boolean;
};

type ActiveTransition = {
  controller: AbortController;
  generation: number;
  kind: ClientLifecycleTransition;
  promise: Promise<void>;
};

export class LifecycleSupersededError extends Error {
  constructor() {
    super("The client lifecycle transition was superseded.");
    this.name = "LifecycleSupersededError";
  }
}

export class LifecycleTransitionContext {
  constructor(
    private readonly owner: ClientLifecycleController,
    readonly generation: number,
    readonly kind: ClientLifecycleTransition,
    readonly signal: AbortSignal,
  ) {}

  get isCurrent(): boolean {
    return (
      !this.signal.aborted &&
      this.owner.isCurrentGeneration(this.generation)
    );
  }

  commit<Result>(operation: () => Result): Result {
    this.throwIfSuperseded();
    return operation();
  }

  throwIfSuperseded(): void {
    if (!this.isCurrent) throw new LifecycleSupersededError();
  }
}

/**
 * Owns browser membership transitions. Terminal work replaces reconnect
 * immediately; every replaced operation keeps its abort signal and generation
 * fence so a late completion cannot commit client state.
 */
export class ClientLifecycleController {
  private current?: ActiveTransition;
  private currentGeneration = 0;

  constructor(
    private readonly onChange: (
      transition: ClientLifecycleTransition | undefined,
    ) => void = () => undefined,
  ) {}

  get active(): ClientLifecycleTransition | undefined {
    return this.current?.kind;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  isCurrentGeneration(generation: number): boolean {
    return generation === this.currentGeneration;
  }

  run(
    kind: ClientLifecycleTransition,
    operation: (transition: LifecycleTransitionContext) => Promise<void>,
  ): Promise<void> {
    const active = this.current;
    if (active) {
      if (isTerminal(kind) && !isTerminal(active.kind)) {
        active.controller.abort(new LifecycleSupersededError());
      } else {
        return active.promise;
      }
    }

    const controller = new AbortController();
    const generation = this.currentGeneration + 1;
    this.currentGeneration = generation;
    const transition = new LifecycleTransitionContext(
      this,
      generation,
      kind,
      controller.signal,
    );
    let tracked!: Promise<void>;
    tracked = Promise.resolve()
      .then(() => operation(transition))
      .catch((error: unknown) => {
        if (controller.signal.aborted && !transition.isCurrent) return;
        throw error;
      })
      .finally(() => {
        if (this.current?.generation !== generation) return;
        this.current = undefined;
        this.onChange(undefined);
      });
    this.current = {
      controller,
      generation,
      kind,
      promise: tracked,
    };
    this.onChange(kind);
    return tracked;
  }
}

export function lifecycleControlState(
  transition: ClientLifecycleTransition | undefined,
  hasActiveRoom: boolean,
): LifecycleControlState {
  const terminal =
    transition === "leave" || transition === "terminate";
  return {
    displayNameDisabled:
      transition === "join" || transition === "resume",
    joinDisabled: transition !== undefined,
    leaveDisabled: !hasActiveRoom || terminal,
    terminateDisabled: !hasActiveRoom || terminal,
  };
}

export async function retryBounded<Result>(
  operation: (attempt: number) => Promise<Result>,
  shouldRetry: (error: unknown) => boolean,
  onRetry: (error: unknown, attempt: number) => Promise<void> | void,
  attempts = 3,
): Promise<Result> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || !shouldRetry(error)) throw error;
      await onRetry(error, attempt);
    }
  }
  throw lastError;
}

function isTerminal(transition: ClientLifecycleTransition): boolean {
  return transition === "leave" || transition === "terminate";
}
