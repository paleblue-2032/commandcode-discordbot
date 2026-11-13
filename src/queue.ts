export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('limit must be at least 1');
    }
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseFunction();
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    return this.releaseFunction();
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    };
  }
}

export class ChannelQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly semaphore: Semaphore;

  constructor(concurrency: number) {
    this.semaphore = new Semaphore(concurrency);
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const started = previous.then(async () => {
      const release = await this.semaphore.acquire();
      try {
        return await task();
      } finally {
        release();
      }
    });

    const settled = started.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) {
        this.chains.delete(key);
      }
    });

    return started;
  }

  get activeChannels(): number {
    return this.chains.size;
  }
}
