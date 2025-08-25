// src/input/controller.ts
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
import { Logger } from "../logger";
import type { RandomScheduler } from "../scheduler";
import { resumeStdin } from "./utils";
import { finalizeAllSandboxes } from "../tools/sandboxed-sh";

export type InputControllerOptions = {
  interjectKey?: string;         // default: "i"
  interjectBanner?: string;      // default: "You: "
  promptTemplate?: (from: string, content: string) => string; // when a model asks the user
  finalizer?: () => void | Promise<void>;   // optional override for tests / DI
  _testMode?: boolean;                        // when true, never process.exit(...)
};

export class InputController {
  private interjectKey: string;
  private interjectBanner: string;
  private promptTemplate: (from: string, content: string) => string;

  private static areKeysEnabled = true;

  private scheduler: RandomScheduler | null = null;

  private rl: readline.Interface | null = null;
  private interjecting = false;

  private keypressHandler?: (str: string, key: readline.Key) => void;

  private escFinalizer?: () => void | Promise<void>;
  private testMode = false;

  constructor(opts: InputControllerOptions = {}) {
    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts.interjectBanner ?? "You: ";
    this.promptTemplate =
      opts.promptTemplate ??
      ((from, _content) => `\n@@${from} requested input\nYou: `);

    this.escFinalizer = opts.finalizer;
    this.testMode = !!opts._testMode;

    // Put stdin into raw/no-echo immediately (if TTY).
    InputController.setRawMode(true);
    this.installRawKeyListener();

    // Clean exit guard to avoid leaving the terminal in raw mode.
    process.on("SIGINT", () => {
      // Fast abort; do NOT finalize (user wanted instant cancel)
      this.detachRawKeyListener();
      InputController.setRawMode(false);
      if (!this.testMode) {
        process.stdout.write("\n");
        process.exit(130);
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
      this.scheduler.handleUserInterjection(initial.trim());
      return;
    }
    // If flag passed without text (true), ask once interactively.
    if (initial === true) {
      const text = await this.runReadlineOnce(this.interjectBanner);
      if (text && text.trim()) this.scheduler.handleUserInterjection(text.trim());
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
        this.scheduler.handleUserInterjection(text);
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

      // Switch to canonical mode; kernel will handle echo for readline.
      InputController.setRawMode(false);

      // Create readline interface with terminal controls enabled.
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        historySize: 50,
        removeHistoryDuplicates: true,
        prompt: "",
      });

      // Ensure a clean line before our prompt, then ask.
      if (!promptText.endsWith(" ")) promptText = promptText + " ";
      this.rl.question(promptText, (answer: string) => {
        try {
          resolve((answer ?? "").trim());
        } finally {
          // Cleanup + restore raw no-echo mode.
          try { this.rl?.close(); resumeStdin(); } catch (e) { Logger.error(e); }
          this.rl = null;
          this.interjecting = false;
          InputController.setRawMode(true);
          this.installRawKeyListener(); // re-attach idle hotkeys
        }
      });
    });
  }

  // --------------------------------------------------------------------------
  // Graceful shutdown on ESC
  // --------------------------------------------------------------------------

  private async gracefulShutdown(): Promise<void> {
    // Stop hotkeys & raw input before any async
    this.detachRawKeyListener();
    InputController.setRawMode(false);

    try { await this.scheduler?.stop?.(); } catch (e) { Logger.error(e); }

    const fin = this.escFinalizer ?? (async () => { await finalizeAllSandboxes(); });
    try { await fin(); } catch (e) { Logger.error(e); }

    if (!this.testMode) {
      process.stdout.write("\n");
      process.exit(0);
    }
  }

  // --------------------------------------------------------------------------
  // Raw key handling (no echo)
  // --------------------------------------------------------------------------

  private installRawKeyListener() {
    if (this.keypressHandler) return; // already installed
    readline.emitKeypressEvents(process.stdin);

    this.keypressHandler = (_str: string, key: readline.Key) => {
      if (!InputController.areKeysEnabled) return;
      if (this.interjecting) return; // readline is active; ignore raw keys
      if (!key) return;

      // Ctrl+C exits quickly (fast abort, no finalize)
      if (key.ctrl && key.name === "c") {
        this.detachRawKeyListener();
        InputController.setRawMode(false);
        if (!this.testMode) {
          process.stdout.write("\n");
          process.exit(130);
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

    // Important: put stdin into raw to prevent kernel echo while idle.
    InputController.setRawMode(true);
    process.stdin.on("keypress", this.keypressHandler);
  }

  private detachRawKeyListener() {
    if (!this.keypressHandler) return;
    try { process.stdin.removeListener("keypress", this.keypressHandler); } catch {}
    this.keypressHandler = undefined;
  }

  /** Centralized raw-mode switch with guards for non-TTY environments. */
  public static setRawMode(enable: boolean) {
    const stdinAny: any = process.stdin as any;
    if (process.stdin.isTTY && typeof stdinAny.setRawMode === "function") {
      try { stdinAny.setRawMode(enable); } catch { /* ignore on CI/non-tty */ }
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

// Factory used by tests to build a controller in "test mode" (no process.exit)
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
