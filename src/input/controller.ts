// src/input/controller.ts
/**
 * Input controller wired to global hotkeys.
 *
 * - Idle: raw TTY; no echo; hotkeys enabled.
 * - Prompting: canonical line mode via readline; echo ON; hotkeys disabled.
 * - ESC: graceful shutdown (unless prompting, where hotkeys are disabled).
 * - Ctrl+C: fast exit (no finalizer).
 *
 * Test hooks: ctl._private.emitKey({ name: "escape" | "c", ctrl?: true })
 */

import * as readline from "readline";
import { Logger } from "../logger";
import type { RandomScheduler } from "../scheduler";
import { resumeStdin } from "./utils";
import { finalizeAllSandboxes } from "../tools/sandboxed-sh";

// Hotkeys module (centralized raw-mode & key routing)
import {
  registerHotkeys,
  disposeHotkeys,
  setHotkeysEnabled,
  setCanonicalMode,
  injectKeyForTests,
} from "../runtime/hotkeys";

export type InputControllerOptions = {
  interjectKey?: string;                 // default: "i"
  interjectBanner?: string;              // default: "You: "
  promptTemplate?: (from: string, content: string) => string;
  finalizer?: () => void | Promise<void>;   // optional injected finalizer
  _testMode?: boolean;                      // when true, never process.exit(...)
  exitOnEsc?: boolean;                      // default: true
  interjectEnabled?: boolean;               // allow “i” hotkey. default: process.stdin.isTTY
};

export class InputController {
  private interjectKey: string;
  private interjectBanner: string;
  private promptTemplate: (from: string, content: string) => string;

  private scheduler: RandomScheduler | null = null;
  private rl: readline.Interface | null = null;
  private interjecting = false;

  private escFinalizer?: () => void | Promise<void>;
  private testMode = false;
  private exitOnEsc = true;
  private allowInterject = !!process.stdin.isTTY;

  constructor(opts: InputControllerOptions = {}) {
    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts.interjectBanner ?? "You: ";
    this.promptTemplate =
      opts.promptTemplate ??
      ((from, _content) => `\n@@${from} requested input\nYou: `);

    this.escFinalizer = opts.finalizer;
    this.testMode = !!opts._testMode;
    this.exitOnEsc = opts.exitOnEsc ?? true;
    this.allowInterject = (typeof opts.interjectEnabled === "boolean")
      ? opts.interjectEnabled
      : !!process.stdin.isTTY;

    // Ensure we’re getting data
    try { resumeStdin(); } catch { /* ignore */ }

    // Install global hotkeys
    registerHotkeys({
      interjectKey: this.interjectKey,
      onInterject: () => {
        if (!this.allowInterject) return;        // disabled in non-interactive
        if (this.interjecting) return;            // already prompting
        this.enterInterjection().catch(err => Logger.error(err));
      },
      onEsc: () => {
        // Only if NOT prompting; prompts disable hotkeys while open
        if (this.interjecting) return;
        void this.gracefulShutdown();
      },
      onCtrlC: () => {
        // Fast abort; do NOT finalize
        if (!this.testMode && this.exitOnEsc) {
          try { setCanonicalMode(true); } catch { }
          process.stdout.write("\n");
          process.exit(130);
        }
      },
    });

    // Hotkeys active in idle
    setHotkeysEnabled(true);

    // Safety: on process end, release hotkeys so we don’t leave raw mode on.
    process.on("exit", () => {
      try { disposeHotkeys(); } catch { }
      try { setCanonicalMode(true); } catch { }
    });
  }

  attachScheduler(s: RandomScheduler) {
    this.scheduler = s;
  }

  /** Allow or disallow interject hotkey at runtime */
  setInterjectEnabled(v: boolean) {
    this.allowInterject = !!v;
  }

  /**
   * Called on startup to seed conversation.
   * If `initial` is a string we send it immediately; if true, open prompt once.
   */
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

  /** Scheduler’s onAskUser callback */
  askUser = async (fromAgent: string, content: string): Promise<string | null> => {
    const promptText = this.promptTemplate(fromAgent, content);
    const text = await this.runReadlineOnce(promptText);
    return (text ?? "").trim() || null;
  };

  // --------------------------------------------------------------------------
  // Interjection hotkey flow (idle → interject → idle)
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

  // --------------------------------------------------------------------------
  // One-shot readline in COOKED mode with hotkeys disabled
  // --------------------------------------------------------------------------

  private runReadlineOnce(promptText: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.interjecting) { resolve(null); return; }
      this.interjecting = true;

      // Disable hotkeys to prevent ESC from finalizing while prompting
      setHotkeysEnabled(false);

      // Switch to canonical mode (echo ON, line editing ON)
      setCanonicalMode(true);

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

      const done = (answer: string) => {
        try { this.rl?.close(); } catch { }
        this.rl = null;

        // Back to raw/hotkeys
        setCanonicalMode(false);
        setHotkeysEnabled(true);

        this.interjecting = false;
        resolve((answer ?? "").trim());
      };

      // Let Ctrl+C cancel the question without finalize; keep symmetry
      this.rl.on("SIGINT", () => {
        // consume & cancel question
        done("");
      });

      this.rl.question(ask, (a: string) => done(a ?? ""));
    });
  }

  // --------------------------------------------------------------------------
  // Graceful shutdown on ESC (idle only; not during prompts)
  // --------------------------------------------------------------------------

  private async gracefulShutdown(): Promise<void> {
    // Stop receiving additional keys
    setHotkeysEnabled(false);

    // Switch to canonical for clean line ending
    setCanonicalMode(true);

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

  private _emitKeyForTests(k: Partial<readline.Key> & { name: string }) {
    injectKeyForTests(k as any);
  }
  private _setFinalizerForTests(fn?: () => void | Promise<void>) {
    this.escFinalizer = fn;
  }

  public readonly _private = {
    emitKey: (k: any) => this._emitKeyForTests(k),
    setFinalizer: (fn?: () => void | Promise<void>) => this._setFinalizerForTests(fn),
  };
}

// Factory for tests (no process.exit)
export function makeControllerForTests(args: {
  scheduler: RandomScheduler;
  finalizer?: () => void | Promise<void>;
}) {
  const c = new InputController({
    _testMode: true,
    finalizer: args.finalizer,
    interjectEnabled: true,
  });
  c.attachScheduler(args.scheduler);
  return c;
}

// Back-compat alias
export const Controller = InputController;
export default InputController;
