export class AsyncTaskQueue<TTask, TResult> {
  private readonly queue: TTask[];

  constructor(tasks: TTask[], private readonly concurrency: number) {
    this.queue = [...tasks];
  }

  async run(
    worker: (task: TTask) => Promise<TResult>,
    options: {
      shouldStop?: () => boolean;
      onResult?: (task: TTask, result: TResult) => Promise<void> | void;
    } = {},
  ): Promise<{ results: TResult[]; remaining: number }> {
    const results: TResult[] = [];
    const workerCount = Math.max(1, this.concurrency);

    await Promise.all(
      Array.from({ length: workerCount }).map(async () => {
        while (true) {
          if (options.shouldStop?.()) {
            return;
          }
          const task = this.queue.shift();
          if (!task) {
            return;
          }
          const result = await worker(task);
          results.push(result);
          await options.onResult?.(task, result);
        }
      }),
    );

    return {
      results,
      remaining: this.queue.length,
    };
  }
}
