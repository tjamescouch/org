// Tiny FIFO mutex to serialize LLM calls (round-robin).
export class TurnMutex {
  private q: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.q.push(() => resolve(() => this.release()));
    });
  }

  private release() {
    const next = this.q.shift();
    if (next) next();
    else this.locked = false;
  }
}

export const shouldSerialize =
  process.env.SERIALIZE_CHAT === "1" || process.env.SERIALIZE_STRATEGY === "rr";

export const globalTurnMutex = new TurnMutex();
