/**
 * Tiny “scopes only” wrapper used by a few unit tests.
 * It shares the same semantics as TtyController’s scoped helpers but without
 * any hotkey logic. We keep it separate so tests that import `defaultTtyScopes`
 * continue to work even if the app constructs its own controller instance.
 */

type TtyMode = "raw" | "cooked";

interface TtyLike {
  isTTY?: boolean;
  isRaw?: boolean;
  isRawMode?: boolean;
  setRawMode?: (raw: boolean) => void;
}

function getIsRaw(tty: TtyLike): boolean {
  return (tty as any).isRaw ?? (tty as any).isRawMode ?? false;
}

class ModeController {
  private current: TtyMode;
  constructor(private readonly tty: TtyLike) {
    this.current = getIsRaw(tty) ? "raw" : "cooked";
  }
  get mode(): TtyMode {
    return this.current;
  }
  toRaw() {
    try { this.tty.setRawMode?.(true); } catch { /* ignore */ }
    this.current = "raw";
  }
  toCooked() {
    try { this.tty.setRawMode?.(false); } catch { /* ignore */ }
    this.current = "cooked";
  }
}

export class TtyScopes {
  private readonly modes: ModeController;
  constructor(private readonly tty: TtyLike) {
    this.modes = new ModeController(tty);
  }
  get mode(): TtyMode {
    return this.modes.mode;
  }

  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.mode;
    this.modes.toCooked();
    try {
      return await fn();
    } finally {
      prev === "raw" ? this.modes.toRaw() : this.modes.toCooked();
    }
  }

  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.mode;
    this.modes.toRaw();
    try {
      return await fn();
    } finally {
      prev === "cooked" ? this.modes.toCooked() : this.modes.toRaw();
    }
  }
}

/** Inert default scopes for tests that import it directly. */
export const defaultTtyScopes = new TtyScopes((process.stdin as unknown) as TtyLike);
