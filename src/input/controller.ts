/**
 * Input controller that guarantees keystrokes are NOT echoed unless
 * we are actively capturing user text (interjection or scheduler prompt).
 *
 * - Idle: raw TTY, no echo. We listen for a hotkey (default "i") to interject.
 * - Prompting: canonical line mode via readline, echo ON, line editing enabled.
 *   After submit, we restore raw/no-echo and reattach the hotkey listener.
 *
 * Adds graceful shutdown on ESC:
 *   - Stops the scheduler
 *   - Calls an injected finalizer (or finalizeAllSandboxes)
 *   - Exits (skips exit when constructed in test mode)
 */

import * as readline from "readline";
import * as tty from "tty";
import { Logger } from "../logger";
import type { RandomScheduler } from "../scheduler";
import { finalizeAllSandboxes } from "../tools/sandboxed-sh";
import { R } from "../runtime/runtime";

export type InputControllerOptions = {
  interjectKey?: string;         // default: "i"
  interjectBanner?: string;      // default: "You: "
  promptTemplate?: (from: string, content: string) => string; // when a model asks the user
  finalizer?: () => void | Promise<void>;   // optional override for tests / DI
  _testMode?: boolean;                        // when true, never R.exit(...)
  exitOnEsc?: boolean;                        // default true
};

function resumeStdinHard() {
  try { if (typeof (R.stdin as any).resume === "function") (R.stdin as any).resume(); } catch {}
}

export class InputController {
  private interjectKey: string;
  private interjectBanner: string;
  private promptTemplate: (from: string, content: string) => string;
  private exitOnEsc = true;

  private static areKeysEnabled = true;

  private scheduler: RandomScheduler | null = null;

  private rl: readline.Interface | null = null;
  private interjecting = false;

  private keypressHandler?: (str: string, key: readline.Key) => void;

  private escFinalizer?: () => void | Promise<void>;
  private testMode = false;

  // ---- Raw-mode / guard helpers -------------------------------------------

  private static guardsInstalled = false;

  /** Return current raw state if available. */
  private static isRawMode(): boolean {
    const anyStdin: any = R.stdin as any;
    return !!(anyStdin && typeof anyStdin.isRaw === "boolean" && anyStdin.isRaw);
  }

  /** Centralized raw-mode switch with guards for non-TTY environments. */
  public static setRawMode(enable: boolean) {
    const stdinAny: any = R.stdin as any;
    if ((R.stdin as tty.ReadStream).isTTY && typeof stdinAny.setRawMode === "function") {
      try { stdinAny.setRawMode(enable); } catch { /* ignore on CI/non-tty */ }
    }
    // Always resume so Node/Bun actually delivers events
    resumeStdinHard();
  }

  /** Ensure we always restore TTY on process-level exits/signals. */
  private static installGlobalTtyGuardsOnce() {
    if (this.guardsInstalled) return;
    this.guardsInstalled = true;

    const restore = () => {
      try { InputController.setRawMode(false); } catch { }
      try { InputController.enableKeys?.(); } catch { }
    };

    R.on("exit", restore);
    R.on("SIGTERM", () => { restore(); R.exit(143); });
    R.on("uncaughtException", (err) => { restore(); Logger.error?.(err); });
    R.on("unhandledRejection", (reason: any) => { restore(); Logger.error?.(reason); });
  }

  /** Run a block in cooked (non-raw) mode and restore previous raw state. */
  private async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    const prevRaw = InputController.isRawMode();
    try {
      InputController.disableKeys();
      if (prevRaw) InputController.setRawMode(false);
      return await fn();
    } finally {
      try { if (prevRaw) InputController.setRawMode(true); } catch { }
      InputController.enableKeys();
      // Re-attach idle hotkeys if we are not already listening.
      this.installRawKeyListener();
    }
  }

  // -------------------------------------------------------------------------

  constructor(opts: InputControllerOptions = {}) {
    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts.interjectBanner ?? "You: ";
    this.promptTemplate =
      opts.promptTemplate ??
      ((from, _content) => `\n@@${from} requested input\nYou: `);

    this.escFinalizer = opts.finalizer;
    this.testMode = !!opts._testMode;
    this.exitOnEsc = opts.exitOnEsc !== false;

    // Global safety net: always restore cooked mode on termination.
    InputController.installGlobalTtyGuardsOnce();

    // Put stdin into raw/no-echo immediately (if TTY) and listen for hotkeys.
    InputController.setRawMode(true);
    resumeStdinHard();
    readline.emitKeypressEvents(R.stdin as any);
    this.installRawKeyListener();

    // Optional: SIGINT fallback; raw handler below already covers ^C fast
    R.on("SIGINT", () => {
      // Fast abort; do NOT finalize (user wanted instant cancel)
      this.detachRawKeyListener();
      try { InputController.setRawMode(false); } catch { }
      if (!this.testMode) {
        R.stdout.write("\n");
        R.exit(130);
      }
    });
  }

  attachScheduler(s: RandomScheduler) {
    this.scheduler = s;
  }

  static disableKeys() {
    this.areKeysEnabled = false;
  }

  static enableKeys() {
    this.areKeysEnabled = true;
  }

  /**
   * Called by app on startup to seed the conversation. If `initial` is given,
   * we broadcast it using the scheduler’s existing fan-out behavior.
   */
  async askInitialAndSend(initial?: string | boolean) {
    if (!this.scheduler) return;
    if (typeof initial === "string" && initial.trim()) {
      // Fire-and-forget; scheduler may be async but we don't block startup.
      (this.scheduler as any).interject?.(initial.trim());
      return;
    }
    // If flag passed without text (true), ask once interactively.
    if (initial === true) {
      const text = await this.runReadlineOnce(this.interjectBanner);
      if (text && text.trim()) {
        (this.scheduler as any).interject?.(text.trim());
      }
    }
  }

  /**
   * Exposed as the scheduler’s `onAskUser` callback. It opens an echoing,
   * line-edited prompt, then restores raw/no-echo.
   */
  askuser = async (fromagent: string, content: string): promise<string | null> => {
    const prompttext = this.prompttemplate(fromagent, content);
    const text = await this.runreadlineonce(prompttext);
    return (text ?? "").trim() || null;
  };

  // --------------------------------------------------------------------------
  // Interjection hotkey flow (idle → interject → idle)
  // --------------------------------------------------------------------------

  /** Hotkey entry to interjection. */
  private async enterInterjection(): Promise<void> {
    if (this.scheduler?.isDraining?.()) return;

    try {
      await this.scheduler?.drain?.();
      const text = await this.runReadlineOnce(this.interjectBanner);
      if (text && this.scheduler) {
        (this.scheduler as any).handleUserInterjection?.(text);
        (this.scheduler as any).interject?.(text);
      }
    } finally {
      this.scheduler?.stopDraining?.();
    }
  }

  /**
   * Core: perform exactly one readline question with echo on, then
   * restore raw/no-echo and the hotkey listener.
   */
  private runReadlineOnce(promptText: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.interjecting) {
        resolve(null);
        return;
      }
      this.interjecting = true;

      // Detach raw hotkey handling to avoid double processing.
      this.detachRawKeyListener();

      // Execute the readline interaction in cooked mode and restore afterwards.
      void this.withCookedTTY(async () => {
        // Switch to canonical mode; kernel will handle echo for readline.
        try { InputController.setRawMode(false); } catch { }

        // Create readline interface with terminal controls enabled.
        this.rl = readline.createInterface({
          input: R.stdin,
          output: R.stdout,
          terminal: true,
          historySize: 50,
          removeHistoryDuplicates: true,
          prompt: "",
        });

        // Immediate ^C inside readline — hit exactly once
        this.rl.on("SIGINT", () => {
          try { this.rl?.close(); } catch {}
          this.rl = null;
          if (!this.testMode) {
            R.stdout.write("\n");
            R.exit(130);
          }
        });

        // ESC inside readline → graceful shutdown
        const onData = (buf: Buffer) => {
          if (Buffer.isBuffer(buf) && buf.length === 1 && buf[0] === 0x1b) {
            try { this.rl?.pause(); this.rl?.close(); } catch {}
            this.rl = null;
            void this.gracefulShutdown();
          }
        };
        (this.rl.input as any).on("data", onData);

        let ask = promptText;
        if (!ask.endsWith(" ")) ask = ask + " ";

        const answer = await new Promise<string>((res) => {
          this.rl!.question(ask, (a: string) => res(a ?? ""));
        });

        (this.rl.input as any).off("data", onData);

        resolve((answer ?? "").trim());
      }).finally(() => {
        // Cleanup + mark not interjecting, regardless of success/failure.
        try { this.rl?.close(); resumeStdinHard(); } catch (e) { Logger.error(e); }
        this.rl = null;
        this.interjecting = false;
        // withCookedTTY will restore raw mode and re-attach hotkeys.
      });
    });
  }

  // --------------------------------------------------------------------------
  // Graceful shutdown on ESC
  // --------------------------------------------------------------------------

  private async gracefulShutdown(): Promise<void> {
    this.detachRawKeyListener();
    InputController.setRawMode(false);

    try { await this.scheduler?.stop?.(); } catch (e) { Logger.error(e); }

    const willExitHere = !this.testMode && this.exitOnEsc;
    const hasCustomFinalizer = !!this.escFinalizer;

    // Only run a finalizer if one was injected OR we’re exiting here.
    if (hasCustomFinalizer) {
      try { await this.escFinalizer!(); } catch (e) { Logger.error(e); }
    } else if (willExitHere) {
      // old behavior remains for exit-on-ESC
      try { await finalizeAllSandboxes(); } catch (e) { Logger.error(e); }
    }

    if (willExitHere) {
      R.stdout.write("\n");
      R.exit(0);
    }
  }

  // --------------------------------------------------------------------------
  // Raw key handling (no echo)
  // --------------------------------------------------------------------------

  private installRawKeyListener() {
    if (this.keypressHandler) return; // already installed
    readline.emitKeypressEvents(R.stdin);

    // Primary path: readline's keypress events
    this.keypressHandler = (_str: string, key: readline.Key) => {
      if (!InputController.areKeysEnabled || this.interjecting || !key) return;

      // Immediate Ctrl+C (fast abort, no finalize)
      if (key.ctrl && key.name === "c") {
        this.detachRawKeyListener();
        try { InputController.setRawMode(false); } catch { }
        if (!this.testMode) {
          R.stdout.write("\n");
          R.exit(130);
        }
        return;
      }

      const name = (key.name || "").toLowerCase();

      // ESC triggers graceful shutdown (finalize sandbox, then exit)
      if (name === "escape" || name === "esc") {
        void this.gracefulShutdown();
        return;
      }

      // Interjection hotkey (single-key)
      if (name === this.interjectKey) {
        this.enterInterjection().catch((err) => Logger.error(err));
      }
    };

    // Fallback: raw 'data' (some environments don’t always emit 'keypress')
    const dataHandler = (buf: Buffer) => {
      if (!InputController.areKeysEnabled || this.interjecting) return;
      if (!Buffer.isBuffer(buf)) return;

      // 0x03 = ^C
      if (buf.length === 1 && buf[0] === 0x03) {
        this.detachRawKeyListener();
        try { InputController.setRawMode(false); } catch {}
        if (!this.testMode) {
          R.stdout.write("\n");
          R.exit(130);
        }
        return;
      }
      // 0x1b = ESC
      if (buf.length === 1 && buf[0] === 0x1b) {
        void this.gracefulShutdown();
        return;
      }
      // 'i' (lowercase) interject shortcut
      if (buf.length === 1 && buf[0] === 0x69 /* 'i' */) {
        this.enterInterjection().catch((err) => Logger.error(err));
        return;
      }
    };

    (this as any)._dataHandler = dataHandler;

    // Important: put stdin into raw to prevent kernel echo while idle.
    InputController.setRawMode(true);
    (R.stdin as any).on("keypress", this.keypressHandler);
    (R.stdin as any).on("data", dataHandler);
  }

  private detachRawKeyListener() {
    if (this.keypressHandler) {
      try { R.stdin.removeListener("keypress", this.keypressHandler); } catch { }
      this.keypressHandler = undefined;
    }
    if ((this as any)._dataHandler) {
      try { R.stdin.removeListener("data", (this as any)._dataHandler); } catch {}
      (this as any)._dataHandler = undefined;
    }
  }

  // ----------------------------- test helpers ------------------------------

  private _emitKeyForTests(k: Partial<readline.Key> & { name: string }) {
    this.keypressHandler?.("", k as readline.Key);
  }
  private _setFinalizerForTests(fn?: () => void | Promise<void>) {
    this.escFinalizer = fn;
  }

  /** Tiny surface for tests */
  public readonly _private = {
    emitKey: (k: any) => this._emitKeyForTests(k),
    setFinalizer: (fn?: () => void | Promise<void>) => this._setFinalizerForTests(fn),
  };
}

// Factory used by tests to build a controller in "test mode" (no R.exit)
export function makeControllerForTests(args: {
  scheduler: RandomScheduler;
  finalizer?: () => void | Promise<void>;
}) {
  const c = new InputController({ _testMode: true, finalizer: args.finalizer });
  c.attachScheduler(args.scheduler);
  return c;
}

// Backward-compat alias if other code referred to Controller
export const Controller = InputController;
export default InputController;
