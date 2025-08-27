// src/input/controller.ts
/**
 * Input controller:
 * - Idle: hotkeys in raw mode (no echo). Interject key triggers a single
 *   readline prompt, then returns to raw mode.
 * - ESC: graceful shutdown (stop scheduler + finalizer)
 * - Ctrl+C: fast exit (no finalizer). In test mode, does not process.exit.
 *
 * Includes a test shim: `ctl._private.emitKey({ name: "escape" })` and
 * `ctl._private.emitKey({ name: "c", ctrl: true })` which forward to
 * the hotkeys’ injector so existing tests keep working.
 */

import * as readline from "readline";
import { Logger } from "../logger";
import type { RandomScheduler } from "../scheduler";
import { resumeStdin } from "./utils";
import { finalizeAllSandboxes } from "../tools/sandboxed-sh";

import {
  registerHotkeys,
  disposeHotkeys,
  setHotkeysEnabled,
  setCanonicalMode,
  injectKeyForTests,
} from "../runtime/hotkeys";

export type InputControllerOptions = {
  interjectKey?: string;         // default: "i"
  interjectBanner?: string;      // default: "You: "
  promptTemplate?: (from: string, content: string) => string;
  finalizer?: () => void | Promise<void>;
  _testMode?: boolean;           // when true, never process.exit(...)
  exitOnEsc?: boolean;           // default: true
};

export class InputController {
  private interjectKey: string;
  private interjectBanner: string;
  private promptTemplate: (from: string, content: string) => string;

  private exitOnEsc = true;
  private testMode = false;

  private scheduler: RandomScheduler | null = null;
  private rl: readline.Interface | null = null;
  private interjecting = false;

  private escFinalizer?: () => void | Promise<void>;

  constructor(opts: InputControllerOptions = {}) {
    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts.interjectBanner ?? "You: ";
    this.promptTemplate =
      opts.promptTemplate ??
      ((from, _content) => `\n@@${from} requested input\nYou: `);

    this.escFinalizer = opts.finalizer;
    this.testMode = !!opts._testMode;
    this.exitOnEsc = opts.exitOnEsc ?? true;

    // Install hotkeys immediately (will re-install once we know the scheduler)
    this.installHotkeys();
  }

  attachScheduler(s: RandomScheduler) {
    this.scheduler = s;
    // re-install to ensure callbacks see the attached scheduler
    this.installHotkeys();
  }

  private installHotkeys() {
    disposeHotkeys();
    registerHotkeys({
      interjectKey: this.interjectKey,
      onInterject: () => { this.enterInterjection().catch(e => Logger.error(e)); },
      onEsc: () => { void this.gracefulShutdown(); },
      onCtrlC: () => {
        // fast abort; do NOT finalize (tests rely on this)
        if (!this.testMode) {
          try { setCanonicalMode(true); } catch { }
          process.stdout.write("\n");
          process.exit(130);
        }
      },
    });
  }

  // --------------------------------------------------------------------------
  // Public API used by app.ts / scheduler
  // --------------------------------------------------------------------------

  async askInitialAndSend(initial?: string | boolean) {
    if (!this.scheduler) return;

    if (typeof initial === "string" && initial.trim()) {
      (this.scheduler as any).interject?.(initial.trim());
      return;
    }

    if (initial === true) {
      const text = await this.runReadlineOnce(this.interjectBanner);
      if (text && text.trim()) {
        (this.scheduler as any).interject?.(text.trim());
      }
    }
  }

  askUser = async (fromAgent: string, content: string): Promise<string | null> => {
    const promptText = this.promptTemplate(fromAgent, content);
    const text = await this.runReadlineOnce(promptText);
    return (text ?? "").trim() || null;
  };

  // --------------------------------------------------------------------------
  // Interjection flow
  // --------------------------------------------------------------------------

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

  /** Exactly one readline question with echo/editing, then restore raw hotkeys. */
  private runReadlineOnce(promptText: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.interjecting) {
        resolve(null);
        return;
      }
      this.interjecting = true;

      setHotkeysEnabled(false);
      setCanonicalMode(true); // cooked

      // Create readline interface with terminal controls enabled.
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

      this.rl.question(ask, (answer: string) => {
        try { this.rl?.close(); resumeStdin(); } catch (e) { Logger.error(e); }
        this.rl = null;
        this.interjecting = false;

        // Back to raw mode with hotkeys enabled
        setCanonicalMode(false);
        setHotkeysEnabled(true);

        resolve((answer ?? "").trim());
      });
    });
  }

  // --------------------------------------------------------------------------
  // Graceful shutdown (ESC)
  // --------------------------------------------------------------------------

  private async gracefulShutdown(): Promise<void> {
    // move out of raw to avoid leaving terminal weird on exit
    try { setCanonicalMode(true); } catch { }

    try { await this.scheduler?.stop?.(); } catch (e) { Logger.error(e); }

    const willExitHere = !this.testMode && this.exitOnEsc;
    const hasCustomFinalizer = !!this.escFinalizer;

    if (hasCustomFinalizer) {
      try { await this.escFinalizer!(); } catch (e) { Logger.error(e); }
    } else if (willExitHere) {
      try { await finalizeAllSandboxes(); } catch (e) { Logger.error(e); }
    }

    if (willExitHere) {
      process.stdout.write("\n");
      process.exit(0);
    }
  }

  // ----------------------------- test helpers ------------------------------

  /** keep old test surface working */
  public readonly _private = {
    /** simulate a keypress in tests (ESC / Ctrl+C / interjectKey) */
    emitKey: (k: { name: string; ctrl?: boolean }) => injectKeyForTests(k),
    /** replace finalizer during tests */
    setFinalizer: (fn?: () => void | Promise<void>) => { this.escFinalizer = fn; },
  };
}

// Factory used by tests to build a controller in "test mode" (no process.exit)
export function makeControllerForTests(args: {
  scheduler: RandomScheduler;
  finalizer?: () => void | Promise<void>;
}) {
  const c = new InputController({ _testMode: true, finalizer: args.finalizer, exitOnEsc: true });
  c.attachScheduler(args.scheduler);
  return c;
}

// Backward-compat alias if other code referred to Controller
export const Controller = InputController;
export default InputController;
