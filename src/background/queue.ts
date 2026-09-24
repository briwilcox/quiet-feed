/**
 * Bounded-concurrency queue with in-flight deduplication. The service worker is
 * shared by every tab, so identical posts in two tabs produce one request.
 */
export class RequestQueue<T> {
  private running = 0;
  private waiting: Array<() => void> = [];
  private inflight = new Map<string, Promise<T>>();

  private readonly concurrency: number;
  private readonly maxWaiting: number;

  constructor(concurrency = 2, maxWaiting = 50) {
    this.concurrency = concurrency;
    this.maxWaiting = maxWaiting;
  }

  run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    if (this.waiting.length >= this.maxWaiting) {
      return Promise.reject(new QueueFullError());
    }
    const p = this.acquire()
      .then(task)
      .finally(() => {
        this.inflight.delete(key);
        this.release();
      });
    this.inflight.set(key, p);
    return p;
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}

export class QueueFullError extends Error {
  constructor() {
    super("Request queue full");
  }
}
