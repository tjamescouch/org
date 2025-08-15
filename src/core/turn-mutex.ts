// Simple FIFO mutex to serialize chat calls (one agent at a time)
export class TurnMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release() {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

// Singleton used app-wide (enabled only when SERIALIZE_CHAT=1)
export const globalTurnMutex = new TurnMutex();

export const shouldSerialize =
  process.env.SERIALIZE_CHAT === "1" ||
  process.env.SERIALIZE_STRATEGY === "rr";
