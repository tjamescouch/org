// src/input/tty-controller.ts
// Centralized, type-safe TTY state management with scoped transitions.
// No external side-effects beyond toggling raw/cooked on the provided stream.

export type TtyMode = "raw" | "cooked";

/**
 * Minimal surface we need from a TTY-like input stream.
 * NodeJS.ReadStream conforms structurally, and test doubles can too.
 */
export type TtyIn = Pick<NodeJS.ReadStream, "isTTY"> &
  Partial<Pick<NodeJS.ReadStream, "setRawMode" | "isRaw">>;

export class TtyController {
  private readonly tty: TtyIn;

  /**
   * Mode stack allows safe nesting (re-entrant scopes). The top of the stack
   * reflects the mode *before* the current scope was entered.
   */
  private readonly modeStack: TtyMode[] = [];

  /** Our current view of the stream's mode. */
  private current: TtyMode;

  constructor(tty: TtyIn) {
    this.tty = tty;
    this.current = this.detectInitialMode(tty);
  }

  /** Returns the controller's view of the current mode. */
  get mode(): TtyMode {
    return this.current;
  }

  /** Enter a cooked TTY scope and restore the previous mode afterwards. */
  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withScopedMode("cooked", fn);
  }

  /** Enter a raw TTY scope and restore the previous mode afterwards. */
  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withScopedMode("raw", fn);
  }

  /**
   * For advanced callers (tests, adapters). Generally prefer the scoped helpers above.
   * Public to make adoption incremental; we can tighten later if desired.
   */
  setMode(next: TtyMode): void {
    if (!this.tty.isTTY || typeof this.tty.setRawMode !== "function") {
      // Non-TTY or no toggling available: just update our local view.
      this.current = next;
      return;
    }

    const wantRaw = next === "raw";
    const isRaw = this.tty.isRaw === true; // Node sets this when in raw mode.

    if (wantRaw && !isRaw) {
      this.tty.setRawMode(true);
    } else if (!wantRaw && isRaw) {
      this.tty.setRawMode(false);
    }

    this.current = next;
  }

  // ---------- Internals ----------

  private detectInitialMode(tty: TtyIn): TtyMode {
    if (!tty.isTTY) return "cooked";
    // Node's ReadStream exposes .isRaw when toggled; if absent, assume cooked.
    return tty.isRaw ? "raw" : "cooked";
  }

  private async withScopedMode<T>(
    next: TtyMode,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    this.modeStack.push(this.current);
    try {
      this.setMode(next);
      return await fn();
    } finally {
      const prev = this.modeStack.pop() ?? "cooked";
      this.setMode(prev);
    }
  }
}

/**
 * Default controller bound to process.stdin.
 * Kept as a convenience; callers may also construct their own with a custom stream.
 */
export const defaultTtyController = new TtyController(process.stdin);
