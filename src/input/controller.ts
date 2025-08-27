/**
 * Input controller:
 *  - Idle: raw TTY with hotkeys (Esc = graceful shutdown; 'i' = interject).
 *  - Prompt: cooked line mode via readline, echo on; hotkeys suspended.
 */

import * as readline from "readline";
import { Logger } from "../logger";
import type { RandomScheduler } from "../scheduler";
import { resumeStdin } from "./utils";
import { finalizeAllSandboxes } from "../tools/sandboxed-sh";
import {
  installHotkeys,
  updateHotkeys,
  suspendHotkeys,
  resumeHotkeys,
  __testOnly_emit as __emitHotkeyForTests,
} from "../runtime/hotkeys";

export type InputControllerOptions = {
  interjectKey?: string;                        // default "i"
  interjectBanner?: string;                     // default "You: "
  promptTemplate?: (from: string, content: string) => string;
  finalizer?: () => void | Promise<void>;       // optional
  _testMode?: boolean;                          // tests: never process.exit
  exitOnEsc?: boolean;                          // default true
  allowInterject?: boolean;                     // default true; set false for non-interactive
};

export class InputController {
  private interjectKey: string;
  private interjectBanner: string;
  private promptTemplate: (from: string, content: string) => string;

  private scheduler: RandomScheduler | null = null;
  private testMode = false;
  private exitOnEsc = true;
  private allowInterject = true;

  private rl: readline.Interface | null = null;
  private interjecting = false;
  private escFinalizer?: () => void | Promise<void>;

  constructor(opts: InputControllerOptions = {}) {
    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts.interjectBanner ?? "You: ";
    this.promptTemplate =
      opts.promptTemplate ?? ((from) => `\n@@${from} requested input\nYou: `);

    this.escFinalizer = opts.finalizer;
    this.testMode = !!opts._testMode;
    this.exitOnEsc = opts.exitOnEsc !== false;
    this.allowInterject = opts.allowInterject !== false;

    // One-time hotkey install
    installHotkeys(
      {
        onEsc: () => { void this.gracefulShutdown(); },
        onCtrlC: () => this.fastAbort(),
        onInterject: () => { void this.enterInterjection(); },
      },
      { interjectKey: this.interjectKey, allowInterject: this.allowInterject },
    );

    // Global safety net: log unexpected errors
    process.on("SIGTERM", () => { /* handled by onEsc when pressed */ });
    process.on("uncaughtException", (err) => { Logger.error(err); });
    process.on("unhandledRejection", (reason: any) => { Logger.error(reason); });
  }

  /** For app wiring: toggle whether 'i' should do anything. */
  public setInterjectEnabled(enabled: boolean) {
    this.allowInterject = !!enabled;
    updateHotkeys({ allowInterject: this.allowInterject, interjectKey: this.interjectKey });
  }

  attachScheduler(s: RandomScheduler) { this.scheduler = s; }

  // --------------------------------------------------------------------------

  async askInitialAndSend(initial?: string | boolean) {
    if (!this.scheduler) return;
    if (typeof initial === "string" && initial.trim()) {
      (this.scheduler as any).interject?.(initial.trim());
      return;
    }
    if (initial === true) {
      const text = await this.runReadlineOnce(this.interjectBanner);
      if (text && text.trim()) (this.scheduler as any).interject?.(text.trim());
    }
  }

  askUser = async (fromAgent: string, content: string): Promise<string | null> => {
    const promptText = this.promptTemplate(fromAgent, content);
    const text = await this.runReadlineOnce(promptText);
    return (text ?? "").trim() || null;
  };

  // --------------------------------------------------------------------------

  private async enterInterjection(): Promise<void> {
    if (this.interjecting) return;
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

  private runReadlineOnce(promptText: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.interjecting) { resolve(null); return; }
      this.interjecting = true;

      // Hand TTY to readline
      suspendHotkeys();

      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        historySize: 50,
        removeHistoryDuplicates: true,
        prompt: "",
      });

      const ask = promptText.endsWith(" ") ? promptText : `${promptText} `;
      this.rl.question(ask, (answer: string) => {
        resolve((answer ?? "").trim());
      });

      // cleanup after question is answered
      this.rl.once("close", () => {
        this.rl = null;
        this.interjecting = false;
        resumeStdin();     // make sure stream flows
        resumeHotkeys();   // give keys back to hotkeys layer
      });
    });
  }

  // --------------------------------------------------------------------------

  private async gracefulShutdown(): Promise<void> {
    // Called from hotkeys (Esc)
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

  private fastAbort() {
    // Ctrl+C → immediate (no finalize)
    if (!this.testMode) {
      process.stdout.write("\n");
      process.exit(130);
    }
  }

  // ----------------------------- test helpers ------------------------------

  public readonly _private = {
    /** Simulate a key: e.g. { name: "escape" } or { name: "c", ctrl: true } */
    emitKey: (k: { name?: string; ctrl?: boolean }) => __emitHotkeyForTests(k),
    /** Swap the ESC finalizer during tests */
    setFinalizer: (fn?: () => void | Promise<void>) => { this.escFinalizer = fn; },
  };
}

// Factory used by tests to build a controller in "test mode" (no process.exit)
export function makeControllerForTests(args: {
  scheduler: RandomScheduler;
  finalizer?: () => void | Promise<void>;
}) {
  const c = new InputController({
    _testMode: true,
    finalizer: args.finalizer,
  });
  c.attachScheduler(args.scheduler);
  return c;
}

export const Controller = InputController;
export default InputController;
