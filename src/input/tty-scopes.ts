// src/input/tty-scopes.ts
// Type-safe, re-entrant scoped TTY helpers. Does not change any existing exports.
// Use from legacy controllers to centralize raw/cooked transitions.

export type TtyMode = "raw" | "cooked";

/** Minimal ReadStream surface we need (compatible with NodeJS.ReadStream). */
export type TtyIn = Pick<NodeJS.ReadStream, "isTTY"> &
  Partial<Pick<NodeJS.ReadStream, "setRawMode" | "isRaw">>;

export class TtyScopes {
  private readonly tty: TtyIn;
  private readonly stack: TtyMode[] = [];
  private current: TtyMode;

  constructor(tty: TtyIn) {
    this.tty = tty;
    this.current = this.detectInitialMode(tty);
  }

  /** Current mode as tracked by the controller. */
  get mode(): TtyMode {
    return this.current;
  }

  /** Run `fn` while in cooked mode, restoring the previous mode afterwards. */
  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withScoped("cooked", fn);
  }

  /** Run `fn` while in raw mode, restoring the previous mode afterwards. */
  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withScoped("raw", fn);
  }

  /** Imperative mode set (prefer the scoped helpers for most use-cases). */
  setMode(next: TtyMode): void {
    if (!this.tty.isTTY || typeof this.tty.setRawMode !== "function") {
      this.current = next;
      return;
    }
    const wantRaw = next === "raw";
    const isRaw = this.tty.isRaw === true;
    if (wantRaw && !isRaw) this.tty.setRawMode(true);
    if (!wantRaw && isRaw) this.tty.setRawMode(false);
    this.current = next;
  }

  // ---- internals ----

  private detectInitialMode(tty: TtyIn): TtyMode {
    if (!tty.isTTY) return "cooked";
    return tty.isRaw ? "raw" : "cooked";
    // If isRaw is undefined we treat it as cooked.
  }

  private async withScoped<T>(next: TtyMode, fn: () => Promise<T> | T): Promise<T> {
    this.stack.push(this.current);
    try {
      this.setMode(next);
      return await fn();
    } finally {
      const prev = this.stack.pop() ?? "cooked";
      this.setMode(prev);
    }
  }
}

/** Convenience singleton bound to process.stdin for gradual adoption. */
export const defaultTtyScopes = new TtyScopes(process.stdin);

/** Factory for custom streams (tests, multiplexers, panes). */
export function createTtyScopes(tty: TtyIn): TtyScopes {
  return new TtyScopes(tty);
}
