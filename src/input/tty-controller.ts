// src/input/tty-controller.ts
// Interactive TTY controller (runtime-owned) with robust raw/cooked state machine.
// - Single stdin owner; raw mode only when not prompting
// - Esc: ALWAYS initiates graceful shutdown (waits for stream to finish, then review)
// - 'i': interject only in interactive mode; queued if pressed during streaming
// - Immediate visual feedback on keypress (newline + message + optional spinner)
// - Public API kept stable for existing callers (start, unwind, readUserLine, askUser, withCookedTTY, withRawTTY, setScheduler)
//
// Notes:
// • The runtime (app.ts) should create exactly one instance and keep it on R.ttyController.
// • Scheduler must call onStreamStart() when first token is emitted, and onStreamEnd() when the model is done.
// • finalizer() passed in options must perform: stop() → drain() → review/pager (and exit is handled here).

import { createInterface as createRl, Interface as ReadlineInterface } from "node:readline";
import { emitKeypressEvents, Key } from "node:readline";
import type { ReadStream as TtyReadStream } from "node:tty";
import type { IScheduler } from "../scheduler/scheduler";
import { Logger } from "../logger";

/* ----------------------------- Types & adapters ----------------------------- */

export type TtyMode = "raw" | "cooked";

export type TtyIn = Pick<NodeJS.ReadStream, "isTTY" | "on" | "off"> &
  Partial<Pick<NodeJS.ReadStream, "setRawMode" | "isRaw">>;

function hasSetRawMode(s: NodeJS.ReadStream): s is TtyReadStream {
  return typeof (s as { setRawMode?: unknown }).setRawMode === "function";
}
function hasIsRaw(s: NodeJS.ReadStream): s is TtyReadStream & { isRaw: boolean } {
  return typeof (s as { isRaw?: unknown }).isRaw === "boolean";
}

export function toTtyIn(stream: NodeJS.ReadStream): TtyIn {
  const base: TtyIn = { isTTY: stream.isTTY === true, on: stream.on.bind(stream), off: (stream as any).off?.bind(stream) ?? ((ev: string, fn: any) => (stream as any).removeListener?.(ev, fn)) };
  if (hasIsRaw(stream)) base.isRaw = stream.isRaw;
  if (hasSetRawMode(stream)) base.setRawMode = (stream as TtyReadStream).setRawMode.bind(stream as TtyReadStream);
  return base;
}

export function stdinTty(): TtyIn { return toTtyIn(process.stdin); }

/* ------------------------------- Mode manager ------------------------------- */

class ModeController {
  private current: TtyMode;

  constructor(private readonly tty: TtyIn) {
    this.current = !tty.isTTY ? "cooked" : tty.isRaw ? "raw" : "cooked";
  }

  get mode(): TtyMode { return this.current; }
  isInteractive(): boolean { return this.tty.isTTY === true; }

  /** Force raw for the lifetime of the controller to avoid OS echo duplication. */
  forceRaw(): void {
    if (this.tty.isTTY && this.tty.setRawMode) {
      this.tty.setRawMode(true);
      this.current = "raw";
    }
  }

  /** Best-effort return to cooked on unwind. */
  toCooked(): void {
    if (this.tty.isTTY && this.tty.setRawMode) {
      this.tty.setRawMode(false);
      this.current = "cooked";
    }
  }

  /** Temporarily switch to cooked; return a disposer that restores raw. */
  toCookedScoped(detach?: () => void, reattach?: () => void): () => void {
    const wasRaw = this.current === "raw";
    if (wasRaw) this.toCooked();
    detach?.();
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      reattach?.();
      if (wasRaw) this.forceRaw();
    };
  }
}

/* --------------------------------- Options --------------------------------- */

export interface TtyControllerOptions {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;

  /** Idle prompt label (e.g., "user: "). A trailing space is enforced. */
  prompt: string;

  /** Interjection key (default 'i'). */
  interjectKey: string;

  /** Interjection prompt label (e.g., "user: "). A trailing space is enforced. */
  interjectBanner: string;

  /** One-line message on ESC during streaming; spinner shown unless suppressed. */
  waitOverlayMessage?: string;
  waitSuppressOutput?: boolean;

  /** Called on graceful unwind (signals/ESC). Should perform: stop → drain → review/pager. */
  finalizer?: () => Promise<void> | void;

  /**
   * Who owns the idle user loop?
   *  - "controller": this class runs the idle loop (default).
   *  - "external": caller (e.g., the scheduler) drives the loop via readUserLine().
   */
  loopMode?: "controller" | "external";
}

/* ------------------------------- Controller -------------------------------- */

type Phase =
  | "Idle"            // RAW
  | "Streaming"       // RAW
  | "ShuttingDown"    // RAW (latched by ESC; finalize when stream ends)
  | "IdlePrompt"      // COOKED
  | "InterjectPrompt" // COOKED
  | "Review";         // COOKED

export class TtyController {
  private readonly mode: ModeController;
  private readonly loopMode: "controller" | "external";
  private schedulerNominal: IScheduler | undefined; // enqueueUserText (typed)
  private schedulerAny: unknown | undefined;        // finalizeAndReview (optional)
  private running = false;
  private reading = false;
  private interjecting = false;
  private keyBound = false;

  // Stream + intent
  private phase: Phase = "Idle";
  private shutdownRequested = false;
  private interjectPending = false;
  private reviewInFlight = false;

  // Immediate feedback
  private spinnerTimer: NodeJS.Timeout | null = null;
  private statusShown = { esc: false, i: false };

  // ESC inside cooked prompt
  private escDuringPrompt = false;

  constructor(private readonly opts: TtyControllerOptions) {
    if (!this.opts.prompt.endsWith(" ")) this.opts.prompt += " ";
    if (!this.opts.interjectBanner.endsWith(" ")) this.opts.interjectBanner += " ";
    this.mode = new ModeController(toTtyIn(opts.stdin));
    this.loopMode = opts.loopMode ?? "controller";
  }

  /* ------------------------------ Public API ------------------------------ */

  setScheduler(s: IScheduler): void {
    this.schedulerNominal = s;
    this.schedulerAny = s;
  }

  /** Bind raw mode and key handlers; spawn the idle loop only if loopMode="controller". */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    emitKeypressEvents(this.opts.stdin);
    this._attachKey();
    this.mode.forceRaw();
    this.phase = "Idle";

    if (this.loopMode === "controller") {
      void this.readLoop();
    }
  }

  /** Gracefully tear down key handlers, restore cooked mode, and call finalizer. */
  async unwind(): Promise<void> {
    this.running = false;
    this._detachKey();
    this.mode.toCooked();
    this._stopSpinner();
    await Promise.resolve(this.opts.finalizer?.());
  }

  /** Allow an external owner (e.g., scheduler) to read one line with our prompt/TTY rules. */
  async readUserLine(label?: string): Promise<string> {
    this.phase = "IdlePrompt";
    const ans = await this.withCookedTTY(() => this.promptOnce(label ?? this.opts.prompt));
    const result = ans ?? "";
    const esc = this.escDuringPrompt;
    this.escDuringPrompt = false;
    this.phase = "Idle";

    if (esc) {
      // Honor "ESC at all times"
      if (this._isStreamingLike()) {
        this.shutdownRequested = true;
        this._statusLine(this.opts.waitOverlayMessage ?? "⏳ ESC pressed — finishing current step, then opening patch review… (Ctrl+C to abort immediately)");
        return "";
      }
      await this._finalizeAndExit();
      return "";
    }

    return result;
  }

  /** Agent asks the user for input; we print the content then prompt once. */
  async askUser(_fromAgent: string, _content: string): Promise<string | undefined> {
    this.phase = "InterjectPrompt";
    const ans = await this.withCookedTTY(() => this.promptOnce(this.opts.interjectBanner));
    const value = (ans ?? "").trim() === "" ? undefined : (ans as string);
    const esc = this.escDuringPrompt;
    this.escDuringPrompt = false;
    this.phase = "Idle";

    if (esc) {
      if (this._isStreamingLike()) {
        this.shutdownRequested = true;
        this._statusLine(this.opts.waitOverlayMessage ?? "⏳ ESC pressed — finishing current step, then opening patch review… (Ctrl+C to abort immediately)");
        return undefined;
      }
      await this._finalizeAndExit();
      return undefined;
    }

    return value;
  }

  /** Scoped helpers: switch to cooked for the duration of fn, then restore raw. */
  async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    if (!this.mode.isInteractive()) {
      return await Promise.resolve(fn());
    }
    const restore = this.mode.toCookedScoped(() => this._detachKey(), () => this._attachKey());
    try {
      return await Promise.resolve(fn());
    } finally {
      restore();
      // enforce invariants after the scope
      this._checkAndHeal("withCookedTTY:exit");
    }
  }

  /** Raw passthrough (kept for API parity). */
  async withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return await Promise.resolve(fn()); }

  /** Called by the scheduler when the model starts emitting tokens. */
  onStreamStart(): void {
    this.phase = "Streaming";
    this.statusShown.esc = false;
    this.statusShown.i = false;
    this._stopSpinner(); // ensure a clean line before streaming resumes
    this._checkAndHeal("onStreamStart");
  }

  /** Called by the scheduler when the model finishes emitting tokens. */
  async onStreamEnd(): Promise<void> {
    const pendingEsc = this.shutdownRequested;
    const pendingI = this.interjectPending;

    this.phase = this.shutdownRequested ? "ShuttingDown" : "Idle";
    this.shutdownRequested = false;
    this.interjectPending = false;
    this._stopSpinner();
    this._checkAndHeal("onStreamEnd");

    // Priority: ESC > interject
    if (pendingEsc) {
      await this._finalizeAndExit();
      return;
    }
    if (pendingI) {
      await this._openInterjectionOnce();
      return;
    }
  }

  /* ------------------------------- Internals ------------------------------- */

  private onKeypress = async (_: string, key: Key) => {
    // Esc → graceful exit path (always active, interactive or not)
    if (key.name === "escape" || key.sequence === "\u001b") {
      if (this._isStreamingLike()) {
        // Defer finalize until stream end; give immediate feedback once.
        this.shutdownRequested = true;
        if (!this.statusShown.esc) {
          this.statusShown.esc = true;
          this._statusLine(this.opts.waitOverlayMessage ?? "⏳ ESC pressed — finishing current step, then opening patch review… (Ctrl+C to abort immediately)");
          this._startSpinner();
        }
        return;
      }
      await this._finalizeAndExit();
      return;
    }

    // Interject only when interactive
    if (key.name === (this.opts.interjectKey || "i")) {
      if (!this.mode.isInteractive()) return;

      // If currently prompting/opening an interjection, ignore repeat presses
      if (this.reading || this.interjecting) return;

      if (this._isStreamingLike()) {
        // Queue interjection until the stream completes; give feedback once.
        this.interjectPending = true;
        if (!this.statusShown.i) {
          this.statusShown.i = true;
          this._statusLine("…waiting for model to finish before interjection");
          this._startSpinner();
        }
        return;
      }

      await this._openInterjectionOnce();
      return;
    }
  };

  private async _openInterjectionOnce(): Promise<void> {
    if (this.interjecting) return;
    this.interjecting = true;
    try {
      const text = await this.withCookedTTY(() => this.promptOnce(this.opts.interjectBanner));
      if (this.escDuringPrompt) {
        this.escDuringPrompt = false;
        await this._finalizeAndExit();
        return;
      }
      if ((text ?? "").trim().length > 0 && hasEnqueueUserText(this.schedulerNominal)) {
        await this.schedulerNominal.enqueueUserText((text as string).trim());
      }
    } finally {
      this.interjecting = false;
    }
  }

  private async _finalizeAndExit(): Promise<void> {
    if (this.reviewInFlight) return;
    this.reviewInFlight = true;
    try {
      this._stopSpinner();
      // Unwind switches to cooked and invokes the provided finalizer (stop → drain → review/apply).
      await this.unwind();
      process.exit(0);
    } catch (err) {
      Logger.warn(`Finalize/review failed: ${String(err)}`);
      try { await this.unwind(); } catch { /* ignore */ }
      process.exit(1);
    } finally {
      this.reviewInFlight = false;
    }
  }

  private async promptOnce(label: string): Promise<string> {
    this.reading = true;
    let rl: ReadlineInterface | null = null;
    let cookedKeyHandler: ((str: string, key: Key) => void) | null = null;

    try {
      // Ensure we can capture ESC even while in cooked mode
      emitKeypressEvents(this.opts.stdin);
      cookedKeyHandler = (_str: string, key: Key) => {
        if (key.name === "escape" || key.sequence === "\u001b") {
          this.escDuringPrompt = true;
          this._statusLine(this.opts.waitOverlayMessage ?? "⏳ ESC pressed — opening patch review…");
          rl?.close();
        }
      };
      this.opts.stdin.on("keypress", cookedKeyHandler);

      rl = createRl({ input: this.opts.stdin, output: this.opts.stdout, terminal: true });
      const answer = await new Promise<string>((resolve) => {
        rl!.question(label, (ans) => resolve(ans));
        rl!.once("close", () => {
          // If closed without a line (e.g., ESC), resolve empty string.
          resolve("");
        });
      });
      return answer;
    } finally {
      if (cookedKeyHandler) this.opts.stdin.off("keypress", cookedKeyHandler);
      rl?.close();
      this.reading = false;
      this._checkAndHeal("promptOnce:exit");
    }
  }

  private _statusLine(msg: string): void {
    try {
      this.opts.stdout.write(`\n${msg}\n`);
    } catch {
      // ignore write errors on teardown
    }
  }

  private _startSpinner(): void {
    if (this.opts.waitSuppressOutput) return;
    if (this.spinnerTimer) return;
    const glyphs = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
    let idx = 0;
    this.spinnerTimer = setInterval(() => {
      try {
        this.opts.stdout.write(`\r${glyphs[idx++ % glyphs.length]} `);
      } catch { /* ignore */ }
    }, 120);
  }

  private _stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      try { this.opts.stdout.write("\r"); } catch { /* ignore */ }
    }
  }

  private _isStreamingLike(): boolean {
    return this.phase === "Streaming" || this.phase === "ShuttingDown";
  }

  private _attachKey(): void {
    if (this.keyBound) return;
    this.opts.stdin.on("keypress", this.onKeypress);
    this.keyBound = true;
  }

  private _detachKey(): void {
    if (!this.keyBound) return;
    this.opts.stdin.off("keypress", this.onKeypress);
    this.keyBound = false;
  }

  /** Enforce invariants and auto-heal drift between phase and raw/cooked bindings. */
  private _checkAndHeal(where: string): void {
    const inCookedPhase = this.phase === "InterjectPrompt" || this.phase === "IdlePrompt" || this.phase === "Review";
    const isCooked = this.mode.mode === "cooked";

    if (inCookedPhase && !isCooked) {
      Logger.debug?.(`[tty invariant] healing to COOKED during ${where}`);
      this.mode.toCooked();
    }
    if (!inCookedPhase && isCooked) {
      Logger.debug?.(`[tty invariant] healing to RAW during ${where}`);
      this.mode.forceRaw();
    }

    if (inCookedPhase && this.keyBound) {
      Logger.debug?.(`[tty invariant] detaching raw key handler during ${where}`);
      this._detachKey();
    }
    if (!inCookedPhase && !this.keyBound && this.mode.isInteractive()) {
      Logger.debug?.(`[tty invariant] reattaching raw key handler during ${where}`);
      this._attachKey();
    }
  }

  /** Default idle loop (only when loopMode === "controller"). */
  private async readLoop(): Promise<void> {
    while (this.running) {
      this.phase = "IdlePrompt";
      const line = await this.withCookedTTY(() => this.promptOnce(this.opts.prompt));
      this.phase = "Idle";
      const txt = (line ?? "").trim();
      const esc = this.escDuringPrompt;
      this.escDuringPrompt = false;

      if (esc) {
        if (this._isStreamingLike()) {
          this.shutdownRequested = true;
          this._statusLine(this.opts.waitOverlayMessage ?? "⏳ ESC pressed — finishing current step, then opening patch review… (Ctrl+C to abort immediately)");
        } else {
          await this._finalizeAndExit();
          return;
        }
      } else if (txt.length > 0 && hasEnqueueUserText(this.schedulerNominal)) {
        await this.schedulerNominal.enqueueUserText(txt);
      }
    }
  }
}

/* ------------------------- Module-level convenience ------------------------- */
/* Kept for API compatibility with older imports. Prefer the runtime-owned instance. */

const _default = new TtyController({
  stdin: process.stdin,
  stdout: process.stdout,
  prompt: "user: ",
  interjectKey: "i",
  interjectBanner: "user: ",
  waitOverlayMessage: "Waiting for agent to finish",
  waitSuppressOutput: true,
});

export function withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withCookedTTY(fn); }
export function withRawTTY<T>(fn: () => Promise<T> | T): Promise<T> { return _default.withRawTTY(fn); }
export async function unwind(): Promise<void> { return _default.unwind(); }

// Optional compatibility: some older code stores a scheduler here (not used by the instance).
let _scheduler: unknown | undefined;
export function setScheduler(s: unknown): void { _scheduler = s; }
export function getScheduler(): unknown | undefined { return _scheduler; }

/* ------------------------------- Type guards ------------------------------- */

function hasEnqueueUserText(x: unknown): x is { enqueueUserText(text: string): Promise<void> | void } {
  return typeof x === "object" && x !== null &&
         "enqueueUserText" in (x as Record<string, unknown>) &&
         typeof (x as Record<string, unknown>)["enqueueUserText"] === "function";
}
