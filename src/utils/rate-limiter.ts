export class RateLimiter {
  private states = new Map<string, LimiterState>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    // Prefer a monotonic clock when available.
    this.now =
      now ??
      (() =>
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now());
  }

  /**
   * Throttle on the named lane so average rate does not exceed `throughputPerSecond`.
   * Await this BEFORE executing the work you want to rate-limit.
   *
   * Guarantees:
   *  - Per `name` fairness (FIFO) under concurrency.
   *  - Deterministic spacing: each permit is scheduled at least 1/tps after the previous one.
   *  - No monkey patching; no global side effects.
   */
  async limit(name: string, throughputPerSecond: number): Promise<void> {
    if (!Number.isFinite(throughputPerSecond) || throughputPerSecond <= 0) {
      throw new RangeError(
        `throughputPerSecond must be a positive finite number; got ${throughputPerSecond}`
      );
    }
    const key = name || "default";
    const state = this.getState(key);

    // Chain atomically on the lane's tail to avoid races when many callers arrive together.
    const waitPromise = state.tail.then(async () => {
      const intervalMs = 1000 / throughputPerSecond;
      const now = this.now();

      // Schedule time is at least the prior nextAvailable, but never in the past.
      const scheduledAt = Math.max(now, state.nextAvailableMs);
      state.nextAvailableMs = scheduledAt + intervalMs;

      const delay = scheduledAt - now;
      if (delay > 0) {
        await sleep(delay);
      }
    });

    // Keep the chain alive even if a caller cancels/throws after awaiting.
    state.tail = waitPromise.catch(() => { /* swallow to keep chain intact */ });

    return waitPromise;
  }

  /** Optional: clear a lane (useful for tests). */
  reset(name?: string): void {
    if (name) {
      this.states.delete(name);
    } else {
      this.states.clear();
    }
  }

  private getState(name: string): LimiterState {
    let s = this.states.get(name);
    if (!s) {
      s = { nextAvailableMs: this.now(), tail: Promise.resolve() };
      this.states.set(name, s);
    }
    return s;
  }
}

type LimiterState = {
  nextAvailableMs: number;
  tail: Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

const rateLimiter = new RateLimiter();
export { rateLimiter };