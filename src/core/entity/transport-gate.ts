/**
 * TransportGate
 *  - strict single-flight network gate with a small cooldown
 *  - use acquire(label) -> release() to serialize outbound chat requests
 */

export type ReleaseFn = () => Promise<void>;

export class TransportGate {
  private cap = 1;
  private inFlight = 0;
  private q: Array<() => void> = [];
  private gate: Promise<void> = Promise.resolve();
  private coolUntil = 0;

  inflight(): number { return this.inFlight; }
  private cooling(): boolean { return Date.now() < this.coolUntil; }

  async acquire(_label: string = ""): Promise<ReleaseFn> {
    // Serialize acquires to avoid races
    let handoff!: () => void;
    const wait = new Promise<void>(res => (handoff = res));
    const prev = this.gate;
    this.gate = (async () => { try { await prev; } finally { handoff(); } })();
    await wait;

    while (this.cooling()) {
      await new Promise(r => setTimeout(r, 25));
    }

    if (this.inFlight < this.cap) {
      this.inFlight = 1;
      return async () => {
        if (this.inFlight === 1) this.inFlight = 0;
        this.coolUntil = Date.now() + 150;
        const n = this.q.shift();
        n?.();
      };
    }

    await new Promise<void>(res => this.q.push(res));
    this.inFlight = 1;
    return async () => {
      if (this.inFlight === 1) this.inFlight = 0;
      this.coolUntil = Date.now() + 150;
      const n = this.q.shift();
      n?.();
    };
  }
}

// Export a singleton instance mirroring the original global usage.
export const transportGate = new TransportGate();
export default transportGate;
