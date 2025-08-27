/**
 * Input controller with clean hotkey integration.
 *
 * - Idle: raw keys handled by runtime/hotkeys.ts (ESC / Ctrl-C / interjectKey).
 * - Prompting: we suspend hotkeys, switch to cooked tty for readline, then resume.
 * - ESC does *graceful* shutdown (drain + finalize) if exitOnEsc=true.
 * - Ctrl-C is fast abort (no finalize) — still restores terminal.
 *
 * Exposes a small _private surface for tests.
 */

import * as readline from "readline";
import { Logger } from "../logger";
import type { RandomScheduler } from "../scheduler";
import { resumeStdin } from "./utils";
import { finalizeAllSandboxes } from "../tools/sandboxed-sh";

import {
  installHotkeys,
  disposeHotkeys,
  suspendHotkeys,
  resumeHotkeys,
  updateHotkeys,
  __testOnly_emit as hotkeysTestEmit,
} from "../runtime/hotkeys";

export type InputControllerOptions = {
  interjectKey?: string;         // default: "i"
  interjectBanner?: string;      // default: "You: "
  promptTemplate?: (from: string, content: string) => string;
  finalizer?: () => void | Promise<void>;   // optional override for tests / DI
  _testMode?: boolean;                        // when true, never process.exit(...)
  exitOnEsc?: boolean;
  /** if false, ignore 'i' interject requests (ESC/Ctrl-C still handled) */
  allowInterject?: boolean;
};

export class InputController {
  private interjectKey: string;
  private interjectBanner: string;
  private promptTemplate: (from: string, content: string) => string;
  private exitOnEsc = true;
  private allowInterject = true;

  private scheduler: RandomScheduler | null = null;

  private rl: readline.Interface | null = null;
  private interjecting = false;

  private escFinalizer?: () => void | Promise<void>;
  private testMode = false;

  // ---- Raw-mode helpers -----------------------------------------------------

  private static isRawMode(): boolean {
    const anyStdin: any = process.stdin as any;
    return !!(anyStdin && typeof anyStdin.isRaw === "boolean" && anyStdin.isRaw);
  }

  public static setRawMode(enable: boolean) {
    const stdinAny: any = process.stdin as any;
    if (process.stdin.isTTY && typeof stdinAny.setRawMode === "function") {
      try { stdinAny.setRawMode(enable); } catch { /* ignore */ }
    }
  }

  private static installProcessGuardsOnce = (() => {
    let installed = false;
    return () => {
      if (installed) return;
      installed = true;

      const restore = () => {
        try { InputController.setRawMode(false); } catch {}
        // do not disposeHotkeys here; app lifecycle handles disposal
      };

      process.on("exit", restore);
      process.on("SIGTERM", () => { restore(); process.exit(143); });
      process.on("uncaughtException", (err) => { restore(); Logger.error?.(err); });
      process.on("unhandledRejection", (reason: any) => { restore(); Logger.error?.(reason); });
    };
  })();

  private async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    const prevRaw = InputController.isRawMode();
    try {
      suspendHotkeys();
      if (prevRaw) InputController.setRawMode(false);
      return await fn();
    } finally {
      try { if (prevRaw) InputController.setRawMode(true); } catch { }
      resumeHotkeys();
    }
  }

  // --------------------------------------------------------------------------

  constructor(opts: InputControllerOptions = {}) {
    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts.interjectBanner ?? "You: ";
    this.promptTemplate =
      opts.promptTemplate ??
      ((from, _content) => `\n@@${from} requested input\nYou: `);

    this.escFinalizer = opts.finalizer;
    this.testMode = !!opts._testMode;
    this.exitOnEsc = opts.exitOnEsc !== false;
    this.allowInterject = opts.allowInterject !== false;

    InputController.installProcessGuardsOnce();

    // Put stdin raw and install hotkeys (idempotent).
    if (process.stdin.isTTY) {
      try { InputController.setRawMode(true); } catch {}
    }

    installHotkeys(
      {
        onEsc: () => this.gracefulShutdown(),
        onCtrlC: () => this.fastAbort(),
        onInterject: () => this.enterInterjection().catch(err => Logger.error(err)),
      },
      {
        interjectKey: this.interjectKey,
        allowInterject: this.allowInterject,
      }
    );
  }

  attachScheduler(s: RandomScheduler) {
    this.scheduler = s;
  }

  updateInterjectAllowance(allow: boolean) {
    this.allowInterject = !!allow;
    updateHotkeys({ interjectKey: this.interjectKey, allowInterject: this.allowInterject });
  }

  // --------------------------------------------------------------------------
  // Prompt seeding
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

  // Scheduler asks user → open one prompt
  askUser = async (fromAgent: string, content: string): Promise<string | null> => {
    const promptText = this.promptTemplate(fromAgent, content);
    const text = await this.runReadlineOnce(promptText);
    return (text ?? "").trim() || null;
  };

  // --------------------------------------------------------------------------
  // Interjection flow
  // --------------------------------------------------------------------------

  private async enterInterjection(): Promise<void> {
    if (!this.scheduler || this.scheduler?.isDraining?.()) return;
    try {
      await this.scheduler.drain?.();
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

      void this.withCookedTTY(async () => {
        this.rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true,
          historySize: 50,
          removeHistoryDuplicates: true,
          prompt: "",
        });

        let ask = promptText;
        if (!ask.endsWith(" ")) ask += " ";

        const answer = await new Promise<string>((res) => {
          this.rl!.question(ask, (a: string) => res(a ?? ""));
        });

        resolve((answer ?? "").trim());
      }).finally(() => {
        try { this.rl?.close(); resumeStdin(); } catch (e) { Logger.error(e); }
        this.rl = null;
        this.interjecting = false;
      });
    });
  }

  // --------------------------------------------------------------------------
  // Shutdown paths
  // --------------------------------------------------------------------------

  private fastAbort() {
    // Fast abort: no finalization, but restore tty.
    try { InputController.setRawMode(false); } catch {}
    if (!this.testMode) {
      process.stdout.write("\n");
      process.exit(130);
    }
  }

  private async gracefulShutdown(): Promise<void> {
    // If we’re mid-readline, just let it finish; otherwise act.
    if (this.interjecting) return;

    try { await this.scheduler?.stop?.(); } catch (e) { Logger.error(e); }

    const willExitHere = !this.testMode && this.exitOnEsc;
    const hasCustomFinalizer = !!this.escFinalizer;

    if (hasCustomFinalizer) {
      try { await this.escFinalizer!(); } catch (e) { Logger.error(e); }
    } else if (willExitHere) {
      try { await finalizeAllSandboxes(); } catch (e) { Logger.error(e); }
    }

    if (willExitHere) {
      try { InputController.setRawMode(false); } catch {}
      process.stdout.write("\n");
      process.exit(0);
    }
  }

  // ----------------------------- test helpers ------------------------------

  private _emitKeyForTests(k: { name?: string; ctrl?: boolean; sequence?: string }) {
    hotkeysTestEmit(k);
  }

  /** Tiny surface for tests */
  public readonly _private = {
    emitKey: (k: any) => this._emitKeyForTests(k),
  };

  // Callers should dispose on process shutdown if needed
  public dispose() {
    disposeHotkeys();
  }
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

// Backward-compat alias if other code referred to Controller
export const Controller = InputController;
export default InputController;
