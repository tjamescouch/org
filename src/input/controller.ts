/**
 * Input controller that guarantees keystrokes are NOT echoed unless
 * we are actively capturing user text (interjection or scheduler prompt).
 *
 * UX rules:
 *  - ESC: graceful shutdown (scheduler.stop(); optional finalizer())
 *  - Ctrl+C: fast exit, no finalize
 *  - Non-interactive (no TTY): auto-synthesize ESC *after* the scheduler is attached
 */

import * as readline from "readline";
import { Logger } from "../logger";
import type { RandomScheduler } from "../scheduler";
import { resumeStdin } from "./utils";

export type InputControllerOptions = {
  interjectKey?: string;         // default: "i"
  interjectBanner?: string;      // default: "You: "
  promptTemplate?: (from: string, content: string) => string;
  /** Optional hook invoked during graceful shutdown (ESC). Useful for tests. */
  onGracefulShutdown?: () => void | Promise<void>;
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
  private readonly interactive: boolean;
  private readonly finalizer?: () => void | Promise<void>;

  // test-helper / internal hook
  public readonly _private = {
    emitKey: (key: { name: string; ctrl?: boolean }) => {
      // Call the same logic the real keypress path uses.
      this.handleKey(key as any);
    },
  };

  constructor(opts: InputControllerOptions = {}) {
    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts.interjectBanner ?? "You: ";
    this.promptTemplate =
      opts.promptTemplate ??
      ((from, _content) => `\n@@${from} requested input\nYou: `);

    this.finalizer = opts.onGracefulShutdown;

    // Determine if we have a real interactive TTY
    this.interactive = !!(process.stdin.isTTY && process.stdout.isTTY);

    // Put stdin into raw/no-echo immediately (if interactive TTY).
    this.setRawMode(this.interactive);
    this.installRawKeyListener();

    // Ctrl+C: fast exit (NO finalize)
    process.on("SIGINT", () => {
      this.detachRawKeyListener();
      this.setRawMode(false);
      process.stdout.write("\n");
      process.exit(0);
    });

    // NOTE: no auto-ESC here. We do it after attachScheduler() so the stop() exists.
  }

  attachScheduler(s: RandomScheduler) {
    this.scheduler = s;

    // In non-interactive runs (CI/e2e), auto-signal ESC after scheduler is ready.
    if (!this.interactive) {
      setTimeout(() => this._private.emitKey({ name: "escape" }), 0);
    }
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
    if (this.scheduler?.isDraining()) return;

    try {
      await this.scheduler?.drain();
      const text = await this.runReadlineOnce(this.interjectBanner);
      if (text && this.scheduler) {
        this.scheduler.handleUserInterjection(text);
      }
    } finally {
      this.scheduler?.stopDraining();
    }
  }

  /**
   * Perform exactly one readline question with echo on, then
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

      // In non-tty we can't prompt; just no-op.
      if (!this.interactive) {
        this.interjecting = false;
        this.installRawKeyListener();
        resolve(null);
        return;
      }

      // Switch to canonical mode; kernel will handle echo for readline.
      this.setRawMode(false);

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
          this.setRawMode(this.interactive);
          this.installRawKeyListener(); // re-attach idle hotkeys
        }
      });
    });
  }

  // --------------------------------------------------------------------------
  // Key handling (shared by real events and tests)
  // --------------------------------------------------------------------------

  private handleKey(key: { name?: string; ctrl?: boolean } | null | undefined) {
    if (!InputController.areKeysEnabled) return;
    if (this.interjecting) return;
    if (!key) return;

    // Ctrl+C exits fast
    if (key.ctrl && key.name === "c") {
      this.detachRawKeyListener();
      this.setRawMode(false);
      process.stdout.write("\n");
      process.exit(0);
    }

    // ESC → graceful shutdown (finalizer + scheduler.stop()).
    if (key.name === "escape") {
      // Run finalizer & stop on the next microtask to keep handler tight.
      queueMicrotask(async () => {
        try {
          if (this.finalizer) await this.finalizer();
        } catch (e) {
          Logger.warn("finalizer failed", e);
        }
        try {
          this.scheduler?.stop();
        } catch (e) {
          Logger.warn("scheduler.stop() failed", e);
        }
      });
      return;
    }

    // Single-key, case-insensitive interjection hotkey.
    const name = (key.name || "").toLowerCase();
    if (name === this.interjectKey) {
      this.enterInterjection().catch((err) => Logger.error(err));
    }
  }

  // --------------------------------------------------------------------------
  // Raw key listener wiring
  // --------------------------------------------------------------------------

  private installRawKeyListener() {
    if (this.keypressHandler) return; // already installed
    readline.emitKeypressEvents(process.stdin);

    this.keypressHandler = (_str: string, key: readline.Key) => {
      this.handleKey(key as any);
    };

    // Only set raw mode if interactive; otherwise stdin may not support it.
    this.setRawMode(this.interactive);
    process.stdin.on("keypress", this.keypressHandler);
  }

  private detachRawKeyListener() {
    if (!this.keypressHandler) return;
    try { process.stdin.removeListener("keypress", this.keypressHandler); } catch {}
    this.keypressHandler = undefined;
  }

  /** Centralized raw-mode switch with guards for non-TTY environments. */
  private setRawMode(enable: boolean) {
    const stdinAny: any = process.stdin as any;
    if (process.stdin.isTTY && typeof stdinAny.setRawMode === "function") {
      try { stdinAny.setRawMode(enable); } catch { /* ignore on CI/non-tty */ }
    }
  }
}

// Backward-compat alias if other code referred to Controller
export const Controller = InputController;
export default InputController;

/** Small factory used only by tests. */
export function makeControllerForTests(args: {
  scheduler: RandomScheduler;
  finalizer?: () => void | Promise<void>;
  interjectKey?: string;
}) {
  const ctl = new InputController({
    onGracefulShutdown: args.finalizer,
    interjectKey: args.interjectKey,
  });
  ctl.attachScheduler(args.scheduler);
  return ctl;
}
