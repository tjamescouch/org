// ChannelLock.ts
import { Logger } from "../logger";

export class ChannelLock {
  private locked = false;
  private queue: Array<{
    give: (release: () => void) => void;
    timeoutId?: Timer;
    id: number;
  }> = [];
  private seq = 0;

  // Timestamp of when the lock was last acquired.  Used for deadlock detection.
  private lastAcquiredAt: number = 0;

  constructor() {
    //FIXME - Try to serialize by just doing one after the other. or putting one at the top of the queue
    const DEADLOCK_MS = Number(process.env.LOCK_DEADLOCK_MS) || 1_200_000;
    setInterval(() => {
      try {
        if (this.locked && this.lastAcquiredAt && Date.now() - this.lastAcquiredAt >= DEADLOCK_MS && this.queue.length > 0) {
          Logger.warn(
            `[DEADLOCK] channel-lock held for ${Date.now() - this.lastAcquiredAt}ms with queueLength=${this.queue.length}. Forcibly releasing.`
          );
          // Mark as unlocked and drain the next waiter.  This forcibly
          // breaks the deadlock by allowing the next queued waiter to
          // proceed.  The current holder is effectively pre-empted.
          this.locked = false;
          // When forcibly breaking a deadlock, rotate the queue so that
          // requests are serialized in a different order.  This reduces the
          // chance of repeating the same blocked pattern.  We move the
          // head of the queue to the end before draining.
          if (this.queue.length > 1) {
            const head = this.queue.shift();
            if (head) this.queue.push(head);
          }
          this.drain();
        }
      } catch {}
    }, 1000);
  }

  async waitForLock(timeout = 0): Promise<() => void> {
    // Emit a debug log whenever a lock acquisition is attempted.  This log
    // reports whether the lock is currently held and how many waiters are
    // queued.  These logs are only emitted when DEBUG logging is enabled.
    try {
      Logger.debug(
        `[DEBUG channel-lock] acquire attempt locked=${this.locked} queueLength=${this.queue.length}`
      );
    } catch {}

    // Fast path: no one waiting and not locked
    if (!this.locked && this.queue.length === 0) {
      this.locked = true;
      // Record when the lock was acquired.  This is used for deadlock detection.
      this.lastAcquiredAt = Date.now();
      try {
        Logger.debug(
          `[DEBUG channel-lock] acquired immediately locked=${this.locked} queueLength=${this.queue.length}`
        );
      } catch {}
      return this.makeRelease();
    }

    // Enqueue and await turn
    return new Promise<() => void>((resolve, reject) => {
      const me = { id: this.seq++, give: (r: () => void) => resolve(r) } as any;

      if (timeout > 0) {
        me.timeoutId = setTimeout(() => {
          // Remove from queue if still waiting
          const i = this.queue.findIndex(q => q.id === me.id);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new Error("ChannelLock timeout"));
        }, timeout);
      }

      this.queue.push(me);
      this.drain();
    });
  }

  private drain() {
    if (this.locked) return;
    const next = this.queue.shift();
    if (!next) return;
    if (next.timeoutId) clearTimeout(next.timeoutId);
    this.locked = true;
    // Record when the lock was acquired for deadlock detection.
    this.lastAcquiredAt = Date.now();
    // Log when a waiter is granted the lock via drain().  This log shows
    // the updated lock state and remaining queue length.
    try {
      Logger.debug(
        `[DEBUG channel-lock] lock granted via drain locked=${this.locked} queueLength=${this.queue.length}`
      );
    } catch {}
    next.give(this.makeRelease());
  }

  private makeRelease(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.locked = false;
      // Clear the last acquired timestamp on release to avoid false
      // positives in the deadlock detector.
      this.lastAcquiredAt = 0;
      // Emit a debug message when the lock is released.  Include the
      // updated queue length for visibility into contention.
      try {
        Logger.debug(
          `[DEBUG channel-lock] released lock locked=${this.locked} queueLength=${this.queue.length}`
        );
      } catch {}
      // Let next waiter run on microtask turn
      queueMicrotask(() => this.drain());
    };
  }
}

const channelLock = new ChannelLock();
export { channelLock };