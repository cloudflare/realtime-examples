type QueueState = {
  operations: Map<string, Promise<unknown>>;
  tail: Promise<void>;
};

export class KeyedLifecycleQueue {
  private readonly queues = new Map<string, QueueState>();

  run<Result>(
    key: string,
    operationId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = {
        operations: new Map(),
        tail: Promise.resolve(),
      };
      this.queues.set(key, queue);
    }
    const existing = queue.operations.get(operationId);
    if (existing) return existing as Promise<Result>;

    const result = queue.tail.then(operation);
    queue.operations.set(operationId, result);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queue.tail = tail;
    const cleanup = () => {
      queue!.operations.delete(operationId);
      if (queue!.tail === tail && queue!.operations.size === 0) {
        this.queues.delete(key);
      }
    };
    void result.then(cleanup, cleanup);
    return result;
  }
}
