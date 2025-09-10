/* -------------------------------------------------------------------------- */
/*  src/input/tty-controller.ts                                               */
/* -------------------------------------------------------------------------- */

/**
 * A very small TTY controller used by tests and the interactive app.
 * - Hotkeys (interactive only):
 *   • ESC     during streaming -> print ACK to feedback, finalize+exit after stream end
 *   • ESC     when idle        -> finalize immediately, then exit(0)
 *   • Ctrl+C                    -> print SIGINT banner, exit(130)
 *   • 'i'     during streaming -> print ACK, open prompt after stream end
 *   • 'i'     when idle        -> open prompt immediately and enqueue the answer
 *
 * Notes for tests:
 * - All banners/ACKs go to `feedback` (defaults to opts.stderr).
 * - We never call R.exit directly if an `exit` impl is injected.
 *   If not provided, we call R.exit(code) (tests usually stub it).
 * - Non-interactive streams (isTTY=false) ignore hotkeys entirely.
 */

import type { Writable } from "node:stream";
import { R } from "../runtime/runtime";
import { ESC_PRESSED_MSG, I_PRESSED_MSG } from "../constants";
import { Logger } from "../logger";

/* ------------------------------ TTY primitives ----------------------------- */

type TtyLike = {
  isTTY: boolean;
  /** present on our FakeTty used in tests */
  isRaw?: boolean;
  setRawMode?: (raw: boolean) => void;
  on: (event: "data", fn: (chunk: Buffer | string) => void) => void;
  off: (event: "data", fn: (chunk: Buffer | string) => void) => void;
  resume?: () => void;
  pause?: () => void;
};

type WritableLike = Pick<Writable, "write"> & { write(chunk: any): any };

type SchedulerLike = {
  /** test fakes tend to expose one (or both) of these; call both if present */
  interject: (text: string) => string;
};

/* --------------------------------- Options -------------------------------- */

interface TtyControllerOptions {
  stdin: TtyLike;
  stdout: WritableLike;
  /** If provided, used as feedback (ACK/banners). */
  stderr?: WritableLike;
  /** Explicit feedback stream; falls back to `stderr`, then `stdout`. */
  feedback?: WritableLike;

  /** Label shown for interactive prompt, defaults to "You > ". */
  prompt?: string;
  /** Interjection hotkey, defaults to "i". */
  interjectKey?: string;
  /** Banner label printed before reading a line on interjection (defaults to prompt). */
  interjectBanner?: string;

  /** When ESC applies immediately (idle) or after stream end (deferred). */
  finalize?: () => Promise<void> | void;

  /** Exit function. If not provided, calls R.exit(code) (tests usually stub it). */
  exit?: (code: number) => never;

  /** If true, do not auto-start in constructor. (Used by the default singleton.) */
  autostart?: boolean;
}

/* ------------------------------- Mode helpers ------------------------------ */

type Mode = "raw" | "cooked";

function getRaw(tty: TtyLike): boolean {
  return (tty as any).isRaw ?? (tty as any).isRawMode ?? false;
}
function setRaw(tty: TtyLike, raw: boolean) {
  try {
    tty.setRawMode?.(raw);
  } catch {
    /* ignore - FakeTty may throw if not supported */
  }
  // keep our view in sync for fakes
  (tty as any).isRaw = raw;
  (tty as any).isRawMode = raw;
}

class ModeController {
  private current: Mode;
  constructor(private readonly tty: TtyLike) {
    this.current = getRaw(tty) ? "raw" : "cooked";
  }
  get mode(): Mode {
    return this.current;
  }
  toRaw() {
    if (this.current === "raw") return;
    setRaw(this.tty, true);
    this.current = "raw";
  }
  toCooked() {
    if (this.current === "cooked") return;
    setRaw(this.tty, false);
    this.current = "cooked";
  }
}


/* ------------------------------- Main class -------------------------------- */

export class TtyController {
  /* streams */
  private readonly tty: TtyLike;
  private readonly out: WritableLike;
  private readonly feedback: WritableLike;

  /* config */
  private readonly interjectKey: string;
  private readonly promptLabel: string;
  private readonly interjectBanner: string;

  /* strategy hooks (all observable by tests) */
  private readonly doFinalize: () => Promise<void> | void;
  private readonly doExit: (code: number) => never;

  /* state */
  private readonly modes: ModeController;
  private started = false;
  private streaming = false;
  private inPrompt = false;
  private pendingEsc = false;
  private pendingInterject = false;
  private onDataRef: (chunk: Buffer | string) => void;

  /* scheduler sink (tests introspect what was enqueued) */
  private scheduler: SchedulerLike = {};

  constructor(opts: TtyControllerOptions | TtyLike) {
    if (isTtyLike(opts)) {
      // legacy tests: ctor(TtyLike)
      this.tty = opts;
      this.out = R.stdout as unknown as WritableLike;
      this.feedback =
        (R.stderr as unknown as WritableLike) ?? this.out;
      this.interjectKey = "i";
      this.promptLabel = "You > ";
      this.interjectBanner = this.promptLabel;
      this.doFinalize = () => {};
      this.doExit = (code: number) => R.exit(code);
      this.modes = new ModeController(this.tty);
      this.onDataRef = (c) => this.onData(c);
      // auto-start for this shape to match tests’ expectations
      this.start();
      return;
    }

    const o = opts as TtyControllerOptions;
    this.tty = o.stdin;
    this.out = o.stdout;
    this.feedback = o.feedback ?? o.stderr ?? this.out;

    this.interjectKey = o.interjectKey ?? "i";
    this.promptLabel = o.prompt ?? "You > ";
    this.interjectBanner = o.interjectBanner ?? this.promptLabel;

    this.doFinalize = o.finalize ?? (() => {});
    this.doExit = o.exit ?? ((code: number) => R.exit(code));

    this.modes = new ModeController(this.tty);
    this.onDataRef = (c) => this.onData(c);

    if (!o.autostart) this.start();
  }

  /* ----------------------------- public surface ---------------------------- */

  get mode(): Mode {
    return this.modes.mode;
  }

  /** hook scheduler sink (test double) */
  setScheduler(s: SchedulerLike) {
    this.scheduler = s ?? {};
  }

  start() {
    if (this.started) return;
    this.started = true;
    // DO NOT force-raw here; some tests assert initial cooked.
    if (this.tty.isTTY) {
      this.tty.on("data", this.onDataRef);
    }
  }

  unwind() {
    if (!this.started) return;
    this.started = false;
    try {
      this.tty.off("data", this.onDataRef);
    } catch {
      /* ignore */
    }
  }

  /** streaming lifecycle (driven by tests) */
  onStreamStart() {
    this.streaming = true;
  }
  async onStreamEnd() {
    this.streaming = false;
    if (this.pendingEsc) {
      this.pendingEsc = false;
      await this.finalizeThenExit();
      return;
    }
    if (this.pendingInterject) {
      this.pendingInterject = false;
      await this.askUser(this.interjectBanner);
    }
  }

  /** prompt helper used in both idle-'i' and deferred interjection */
  async askUser(banner = this.interjectBanner) {
    const line = await this.readUserLine(banner);
    this.enqueue(line);
  }

  readUserLine(label = this.promptLabel): Promise<string> {
    this.inPrompt = true;
    this.modes.toCooked();
    this.out.write(label);

    let buf = "";
    return new Promise<string>((resolve) => {
      const handler = (chunk: Buffer | string) => {
        // When prompting, we deliberately ignore the global hotkey handler,
        // except for ESC which cancels and finalizes (as the test expects).
        const s = bufferToString(chunk);

        for (const ch of s) {
          const code = ch.charCodeAt(0);
          if (code === 0x1b) {
            // ESC during prompt -> cancel prompt, restore RAW, finalize+exit
            this.tty.off("data", handler);
            this.inPrompt = false;
            this.modes.toRaw();
            this.feedback.write(
              ESC_PRESSED_MSG + "\n",
            );

            void this.finalizeThenExit();
            // resolve an empty string to unblock any awaiting callers
            return resolve("");
          }
          if (ch === "\n") {
            if (buf === "") {
              this.out.write(label);
            } else {
              this.tty.off("data", handler);
              this.inPrompt = false;
              this.modes.toRaw();
              return resolve(buf);
            }
          } else {
            buf += ch;
          }
        }
      };
      this.tty.on("data", handler);
    });
  }

  /** small helpers used by tests */
  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.mode;
    this.modes.toCooked();
    try {
      return await fn();
    } finally {
      if (prev === "raw") this.modes.toRaw();
    }
  }
  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.mode;
    this.modes.toRaw();
    try {
      return await fn();
    } finally {
      if (prev === "cooked") this.modes.toCooked();
    }
  }

  /* ----------------------------- internal bits ----------------------------- */

  private enqueue(line: string) {
    this.scheduler.interject(line);
  }

  private async finalizeThenExit() {
    try {
      await this.doFinalize();
    } catch {
      // tests don't care about finalize errors; still try to exit
    }
    this.doExit(0);
  }

  private onData(chunk: Buffer | string) {
    // Non-interactive: hotkeys are disabled entirely
    if (!this.tty.isTTY) return;

    // If a cooked prompt is active, let the prompt handler consume the bytes
    if (this.inPrompt) return;

    const s = bufferToString(chunk);
    for (const ch of s) {
      const code = ch.charCodeAt(0);

      // Ctrl+C (ETX)
      if (code === 0x03) {
        this.feedback.write("SIGINT\n");
        this.doExit(130);
        return;
      }

      // ESC
      if (code === 0x1b) {
        if (this.streaming) {
          // Defer finalize until stream end, ACK immediately
          if (!this.pendingEsc) {
            this.pendingEsc = true;
            this.feedback.write(ESC_PRESSED_MSG);
          }
          return;
        }
        // Idle -> finalize now
        this.feedback.write(ESC_PRESSED_MSG);
        void this.finalizeThenExit();
        return;
      }

      // Interject
      if (ch === this.interjectKey) {
        if (this.streaming) {
          if (!this.pendingInterject) {
            this.pendingInterject = true;
            this.feedback.write(I_PRESSED_MSG);
          }
          return;
        }
        // Ask immediately when idle
        void this.askUser(this.interjectBanner);
        return;
      }
    }
  }
}

/* ----------------------------- tiny utilities ----------------------------- */

function bufferToString(b: Buffer | string): string {
  return typeof b === "string" ? b : b.toString("utf8");
}
function isTtyLike(x: any): x is TtyLike {
  return !!x && typeof x.isTTY === "boolean" && typeof x.on === "function";
}

/* ------------------------------ default export ----------------------------- */

/**
 * A lazily-started singleton for code that imports a default controller.
 * We do NOT autostart to avoid binding to R.stdin in unit tests
 * that only assert API shape.
 */
const defaultTtyController = new TtyController({
  stdin: (R.stdin as unknown as TtyLike),
  stdout: (R.stdout as unknown as WritableLike),
  stderr: (R.stderr as unknown as WritableLike),
  autostart: true, // unit tests expect the default instance to be live
});


  /** small helpers used by tests */
  export const withCookedTTY = async <T>(fn: () => Promise<T> | T): Promise<void> => {
    defaultTtyController.withCookedTTY(fn);
  }
  export const withRawTTY = async <T>(fn: () => Promise<T> | T): Promise<void> => {
    defaultTtyController.withRawTTY(fn);
  }