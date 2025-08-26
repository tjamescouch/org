// src/input/controller.ts
/**
 * Input controller that guarantees keystrokes are NOT echoed unless
 * we are actively capturing user text (interjection or scheduler prompt).
 *
 * - Idle: raw TTY, no echo. We listen for a hotkey (default "i") to interject.
 * - Prompting: canonical line mode via readline, echo ON, line editing enabled.
 *   After submit, we restore raw/no-echo and reattach the hotkey listener.
 *
 * Adds graceful shutdown on ESC (debounced bare-ESC; arrows won't exit):
 *   - Stops the scheduler
 *   - Calls an injected finalizer (or finalizeAllSandboxes)
 *   - Exits (skips exit when constructed in test mode, or when exitOnEsc=false)
 */

import * as readline from "readline";
import { Logger } from "../logger";
import type { RandomScheduler } from "../scheduler";
import { resumeStdin } from "./utils";
import { finalizeAllSandboxes } from "../tools/sandboxed-sh";
import { Hotkeys } from "../runtime/hotkeys";

export type InputControllerOptions = {
  interjectKey?: string;         // default: "i"
  interjectBanner?: string;      // default: "You: "
  promptTemplate?: (from: string, content: string) => string; // when a model asks the user
  finalizer?: () => void | Promise<void>;   // optional override for tests / DI
  _testMode?: boolean;           // when true, never process.exit(...)
  exitOnEsc?: boolean;           // default: true
};

export class InputController {
  private interjectKey: string;
  private interjectBanner: string;
  private promptTemplate: (from: string, content: string) => string;
  private exitOnEsc = true;

  private static areKeysEnabled = true;

  private scheduler: RandomScheduler | null = null;

  private rl: readline.Interface | null = null;
  private interjecting = false;

  private escFinalizer?: () => void | Promise<void>;
  private testMode = false;

  private hotkeys: Hotkeys | null = null;
  private exiting = false;

  // ---- Raw-mode / guard helpers -------------------------------------------

  private static guardsInstalled = false;

  /** Return current raw state if available. */
  private static isRawMode(): boolean {
    const anyStdin: any = process.stdin as any;
    return !!(anyStdin && typeof anyStdin.isRaw === "boolean" && anyStdin.isRaw);
  }

  /** Centralized raw-mode switch with guards for non-TTY environments. */
  public static setRawMode(enable: boolean) {
    const stdinAny: any = process.stdin as any;
    if (process.stdin.isTTY && typeof stdinAny.setRawMode === "function") {
      try { stdinAny.setRawMode(enable); } catch { /* ignore on CI/non-tty */ }
    }
  }

  /** Ensure we always restore TTY on process-level exits/signals. */
  private static installGlobalTtyGuardsOnce() {
    if (this.guardsInstalled) return;
    this.guardsInstalled = true;

    const restore = () => {
      try { InputController.setRawMode(false); } catch { }
      try { InputController.enableKeys?.(); } catch { }
    };

    process.on("exit", restore);
    process.on("SIGTERM", () => { restore(); process.exit(143); });
    process.on("uncaughtException", (err) => { restore(); Logger.error?.(err); });
    process.on("unhandledRejection", (reason: any) => { restore(); Logger.error?.(reason); });
  }

  /** Run a block in cooked (non-raw) mode and restore previous raw state + hotkeys. */
  private async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    const prevRaw = InputController.isRawMode();
    try {
      InputController.disableKeys();
      // Temporarily disable hotkeys to avoid interpreting typed characters
      this.hotkeys?.disable();
      if (prevRaw) InputController.setRawMode(false);
      return await fn();
    } finally {
      try { if (prevRaw) InputController.setRawMode(true); } catch { }
      InputController.enableKeys();
      // Re-enable hotkeys for idle/raw mode
      this.hotkeys?.enable();
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
    this.exitOnEsc = opts.exitOnEsc ?? true;

    // Global safety net: always restore cooked mode on termination.
    InputController.installGlobalTtyGuardsOnce();

    // Put stdin into raw/no-echo immediately (if TTY).
    InputController.setRawMode(true);

    // Debounced-ESC hotkeys: ESC (graceful), Ctrl+C (fast abort), interject
    this.hotkeys = new Hotkeys(
      {
        onInterject: () => this.enterInterjection().catch((e) => Logger.error(e)),
        onEsc: () => this.gracefulShutdown(),
        onCtrlC: () => this.fastAbort(),
      },
      { interjectKey: this.interjectKey, escDelayMs: 80, debug: !!process.env.DEBUG }
    );
    this.hotkeys.enable();

    // Process-level SIGINT (belt-and-suspenders for terminals that don’t deliver keypress)
    process.on("SIGINT", () => this.fastAbort());
  }

  private fastAbort() {
    if (this.exiting) return;
    // Fast abort; do NOT finalize (user wanted instant cancel)
    this.hotkeys?.disable();
    InputController.setRawMode(false);
    if (!this.testMode) {
      this.exiting = true;
      process.stdout.write("\n");
      process.exit(130);
    }
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
      // Use scheduler's public interject entry
      await (this.scheduler as any).interject?.(initial.trim());
      return;
    }
    // If flag passed without text (true), ask once interactively.
    if (initial === true) {
      const text = await this.runReadlineOnce(this.interjectBanner);
      if (text && text.trim()) {
        await (this.scheduler as any).interject?.(text.trim());
      }
    }
  }

  /**
   * Exposed as the scheduler’s `onAskUser` callback. It opens an echoing,
   * line-edited prompt, then restores raw/no-echo.
   */
  askUser = async (fromAgent: string, content: string): Promise<string | null> => {
    const promptText = this.promptTemplate(fromAgent, content);
    const text = await this.runReadlineOnce(promptText);
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
        // Single point of truth for routing user text
        await (this.scheduler as any).interject?.(text);
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

      void this.withCookedTTY(async () => {
        // Create readline interface with terminal controls enabled (cooked mode)
        this.rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true,
          historySize: 50,
          removeHistoryDuplicates: true,
          prompt: "",
        });

        let ask = promptText;
        if (!ask.endsWith(" ")) ask = ask + " ";

        const answer = await new Promise<string>((res) => {
          this.rl!.question(ask, (a: string) => res(a ?? ""));
        });

        resolve((answer ?? "").trim());
      }).finally(() => {
        // Cleanup regardless of success/failure.
        try { this.rl?.close(); resumeStdin(); } catch (e) { Logger.error(e); }
        this.rl = null;
        this.interjecting = false;
      });
    });
  }

  // --------------------------------------------------------------------------
  // Graceful shutdown on ESC
  // --------------------------------------------------------------------------

  private async gracefulShutdown(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;

    this.hotkeys?.disable();
    InputController.setRawMode(false);

    try { await this.scheduler?.stop?.(); } catch (e) { Logger.error(e); }

    const willExitHere = !this.testMode && this.exitOnEsc;
    const hasCustomFinalizer = !!this.escFinalizer;

    // Only run a finalizer if one was injected OR we’re exiting here.
    if (hasCustomFinalizer) {
      try { await this.escFinalizer!(); } catch (e) { Logger.error(e); }
    } else if (willExitHere) {
      // Default finalizer: finalize all sandboxes to preserve patches/artifacts
      try { await finalizeAllSandboxes(); } catch (e) { Logger.error(e); }
    }

    if (willExitHere) {
      process.stdout.write("\n");
      process.exit(0);
    }
  }

  // ----------------------------- test helpers ------------------------------

  private _emitKeyForTests(k: Partial<readline.Key> & { name: string }) {
    // Minimal simulation for tests without plumbed keypress stream:
    const name = (k.name || "").toLowerCase();
    if (k.ctrl && name === "c") { this.fastAbort(); return; }
    if (name === "escape" || name === "esc") { void this.gracefulShutdown(); return; }
    if (name === this.interjectKey) { void this.enterInterjection(); return; }
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

// Factory used by tests to build a controller in "test mode" (no process.exit)
export function makeControllerForTests(args: {
  scheduler: RandomScheduler;
  finalizer?: () => void | Promise<void>;
}) {
  const c = new InputController({ _testMode: true, finalizer: args.finalizer, exitOnEsc: false });
  c.attachScheduler(args.scheduler);
  return c;
}

// Backward-compat alias if other code referred to Controller
export const Controller = InputController;
export default InputController;
