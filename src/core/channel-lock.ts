// ChannelLock.ts
export class ChannelLock {
  private locked = false;
  private queue: Array<{
    give: (release: () => void) => void;
    timeoutId?: Timer;
    id: number;
  }> = [];
  private seq = 0;

  async waitForLock(timeout = 0): Promise<() => void> {
    // Fast path: no one waiting and not locked
    if (!this.locked && this.queue.length === 0) {
      this.locked = true;
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
    next.give(this.makeRelease());
  }

  private makeRelease(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.locked = false;
      // Let next waiter run on microtask turn
      queueMicrotask(() => this.drain());
    };
  }
}

const channelLock = new ChannelLock();
export { channelLock };