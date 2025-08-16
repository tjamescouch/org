/**
 * PauseController
 *  - centralizes user-pause and interjection state
 *  - avoids scattered globals; exposes simple static helpers
 */
export class PauseController {
  /** Returns true if the system is currently paused for user input. */
  static isPaused(): boolean {
    return Boolean((globalThis as any).__PAUSE_INPUT);
  }

  /** Wait until the pause flag is cleared (polling with a small delay). */
  static async waitWhilePaused(): Promise<void> {
    while (PauseController.isPaused()) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Record a user interjection timestamp, globally visible. */
  static markUserInterject(): void {
    const obj = (globalThis as any).__userInterrupt || { ts: 0 };
    obj.ts = Date.now();
    (globalThis as any).__userInterrupt = obj;
  }

  /** Last user interjection timestamp (0 if none). */
  static lastInterjectTs(): number {
    const obj = (globalThis as any).__userInterrupt || { ts: 0 };
    return obj.ts || 0;
  }

  /** Convenience helper: has an interjection occurred in the last N ms? */
  static interjectedWithin(ms: number): boolean {
    return Date.now() - PauseController.lastInterjectTs() < ms;
  }
}

export default PauseController;
