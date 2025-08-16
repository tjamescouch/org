/**
 * ChannelLock — portable async mutex with:
 *  - FIFO fairness
 *  - microtask handoff
 *  - waiter acquire timeouts
 *  - lease + `touch()` to refresh while streaming
 *  - watchdog to break stale holders
 *
 * No monkey-patching, no Node/Bun-specific dependencies.
 */

export type ReleaseFn = (() => Promise<void>) & { touch?: () => void };

type Resolver<T> = (v: T) => void;

interface ChannelLockOptions {
  /** Max time a holder can keep the lock without touching (ms). Default 2000. */
  leaseMs?: number;
  /** How frequently to check for stale holders (ms). Default 250. */
  pollMs?: number;
  /** Optional tag for debug logs. */
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

  async waitForLock(timeoutMs: number = 10_000, label: string = "anon"): Promise<ReleaseFn> {
    // Fast-path when free
    if (!this._holder) {
      this._holder = this._newHolder(label);
      return this._makeRelease(this._holder);
    }

    // Queue and wait (FIFO)
    const release = await new Promise<ReleaseFn>((resolve, reject) => {
      const item = { label, resolve, reject, timeout: undefined as any };
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        item.timeout = setTimeout(() => {
          const idx = this._q.indexOf(item as any);
          if (idx >= 0) this._q.splice(idx, 1);
          reject(new Error(`ChannelLock: acquire timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this._q.push(item as any);
    });
    return release;
  }

  async run<T>(fn: () => Promise<T>, timeoutMs?: number, label?: string): Promise<T> {
    const release = await this.waitForLock(timeoutMs, label);
    try { return await fn(); }
    finally { await release(); }
  }

  /** Manually refresh the current holder's lease. */
  touch(): void {
    if (this._holder) this._holder.lastTouch = Date.now();
  }

  // ---- internals -----------------------------------------------------------

  private _debug(msg: string) {
    try {
      const lvl = (globalThis as any).process?.env?.LOG_LEVEL ?? "";
      if (String(lvl).toUpperCase().includes("DEBUG")) {
        // eslint-disable-next-line no-console
        console.debug(`[${this.opts.debugTag}] ${msg}`);
      }
    } catch { /* ignore */ }
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
        this._forceRelease();
      }
    }, this.opts.pollMs);
  }

  private _forceRelease() {
    const h = this._holder;
    if (!h) return;
    this._holder = null;
    queueMicrotask(() => this._grantNext());
  }

  private _grantNext() {
    while (this._q.length) {
      const next = this._q.shift()!;
      if (next.timeout) clearTimeout(next.timeout);
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
      if (this._holder && this._holder.id === h.id) {
        this._holder = null;
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

// Default singleton
export const channelLock = new ChannelLock();
