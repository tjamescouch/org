/**
 * ChannelLock — a tiny async mutex with:
 *  - FIFO fairness
 *  - microtask handoff (grant to the next waiter on a microtask)
 *  - waiter timeouts
 *  - deadlock/lease breaker with `touch()` to refresh
 *  - zero monkey‑patching; no Node/Bun specifics
 *
 * Usage
 *   const release = await channelLock.waitForLock(5000, "fetch");
 *   try {
 *     // ...critical section...
 *     // During long running streaming operations, keep the lease alive:
 *     release.touch?.();
 *   } finally {
 *     await release();
 *   }
 */
export type ReleaseFn = (() => Promise<void>) & { touch?: () => void };
type Resolver<T> = (v: T) => void;

interface ChannelLockOptions {
  /** Max time a holder can keep the lock without touching (ms). Default 2000. */
  leaseMs?: number;
  /** How frequently to check for stale holders (ms). Default 250. */
  pollMs?: number;
  /** Optional debug label printed with console.debug when LOG_LEVEL=DEBUG. */
  debugTag?: string;
}

interface Holder {
  id: number;
  label: string;
  acquiredAt: number;
  lastTouch: number;
  released: boolean;
}

export class ChannelLock {
  private opts: Required<ChannelLockOptions>;
  private _holder: Holder | null = null;
  private _q: Array<{
    label: string;
    resolve: Resolver<ReleaseFn>;
    reject: (err: any) => void;
    timeout?: any;
  }> = [];
  private _nextId = 1;
  private _watchTimer: any = null;

  constructor(options?: ChannelLockOptions) {
    this.opts = {
      leaseMs: options?.leaseMs ?? 2000,
      pollMs: options?.pollMs ?? 250,
      debugTag: options?.debugTag ?? "channel-lock",
    };
    this._startWatchdog();
  }

  get locked(): boolean { return !!this._holder; }
  get queueLength(): number { return this._q.length; }

  /**
   * Acquire the lock, waiting up to `timeoutMs` before rejecting.
   * Returns an async release function. The release function is idempotent.
   * The returned function also has a `touch()` method to refresh the lease.
   */
  async waitForLock(timeoutMs: number = 10_000, label: string = "anon"): Promise<ReleaseFn> {
    if (!this._holder) {
      this._holder = this._newHolder(label);
      return this._makeRelease(this._holder);
    }

    const waiter = await new Promise<ReleaseFn>((resolve, reject) => {
      const item = { label, resolve, reject, timeout: undefined as any };
      // Timeout for waiting
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        item.timeout = setTimeout(() => {
          // Remove this waiter from queue if still present
          const idx = this._q.indexOf(item as any);
          if (idx >= 0) this._q.splice(idx, 1);
          reject(new Error(`ChannelLock: acquire timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this._q.push(item as any);
    });

    return waiter;
  }

  /**
   * Convenience wrapper to run a critical section under the lock.
   */
  async run<T>(fn: () => Promise<T>, timeoutMs?: number, label?: string): Promise<T> {
    const release = await this.waitForLock(timeoutMs, label);
    try { return await fn(); }
    finally { await release(); }
  }

  /** Manually refresh the current holder's lease. (Usually call `release.touch?.()` instead.) */
  touch(): void {
    if (this._holder) this._holder.lastTouch = Date.now();
  }

  // -- internals ------------------------------------------------------------

  private _debug(msg: string) {
    // Print only when LOG_LEVEL looks like DEBUG
    try {
      const lvl = (globalThis as any).process?.env?.LOG_LEVEL ?? "";
      if (String(lvl).toUpperCase().includes("DEBUG")) {
        // eslint-disable-next-line no-console
        console.debug(`[${this.opts.debugTag}] ${msg}`);
      }
    } catch { /* noop */ }
  }

  private _newHolder(label: string): Holder {
    const now = Date.now();
    return { id: this._nextId++, label, acquiredAt: now, lastTouch: now, released: false };
  }

  private _startWatchdog() {
    if (this._watchTimer) return;
    this._watchTimer = setInterval(() => {
      const h = this._holder;
      if (!h) return;
      const age = Date.now() - Math.max(h.lastTouch, h.acquiredAt);
      if (age > this.opts.leaseMs) {
        this._debug(`lease expired for holder=${h.label} (id=${h.id}); breaking and rotating queue`);
        // Force release and grant next if any
        this._forceRelease();
      }
    }, this.opts.pollMs);
  }

  private _forceRelease() {
    const h = this._holder;
    if (!h) return;
    this._holder = null;
    // microtask handoff
    queueMicrotask(() => this._grantNext());
  }

  private _grantNext() {
    while (this._q.length) {
      const next = this._q.shift()!;
      if (next.timeout) clearTimeout(next.timeout);
      // Next holder becomes active
      const h = this._newHolder(next.label);
      this._holder = h;
      const release = this._makeRelease(h);
      next.resolve(release);
      return;
    }
  }

  private _makeRelease(h: Holder): ReleaseFn {
    const release: any = async () => {
      if (h.released) return;
      h.released = true;
      // Only the current holder may release the global lock
      if (this._holder && this._holder.id === h.id) {
        this._holder = null;
        // microtask handoff (do not grant synchronously)
        queueMicrotask(() => this._grantNext());
      }
    };
    release.touch = () => {
      if (this._holder && this._holder.id === h.id) {
        this._holder.lastTouch = Date.now();
      }
    };
    return release as ReleaseFn;
  }
}

// Default singleton used throughout the project
export const channelLock = new ChannelLock();
