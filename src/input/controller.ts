// src/input/controller.ts
/**
 * Input controller that guarantees keystrokes are NOT echoed unless
 * we are actively capturing user text (interjection or scheduler prompt).
 *
 * Idle: raw TTY (no echo) + hotkeys (ESC / interject / Ctrl+C).
 * Prompting: cooked line mode via readline; hotkeys suspended.
 * ESC = graceful finalize; Ctrl+C = fast abort (no finalize).
 */

import * as readline from "readline";
import { Logger } from "../logger";
import type { RandomScheduler } from "../scheduler";
import { resumeStdin } from "./utils";
import { finalizeAllSandboxes } from "../tools/sandboxed-sh";

// Hotkeys glue (runtime path)
import {
  installHotkeys, suspendHotkeys, resumeHotkeys, updateHotkeys,
  __testOnly_emit as _emitForTests
} from "../runtime/hotkeys";

export type InputControllerOptions = {
  interjectKey?: string;         // default: "i"
  interjectBanner?: string;      // default: "You: "
  promptTemplate?: (from: string, content: string) => string;
  finalizer?: () => void | Promise<void>;
  _testMode?: boolean;           // never process.exit in tests
  exitOnEsc?: boolean;

  /** If false, disable prompts/interjection entirely (for non-interactive runs). */
  allowInterject?: boolean;      // default true
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

  constructor(opts: InputControllerOptions = {}) {
    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts.interjectBanner ?? "You: ";
    this.promptTemplate =
      opts.promptTemplate ?? ((from) => `\n@@${from} requested input\nYou: `);

    this.escFinalizer = opts.finalizer;
    this.testMode = !!opts._testMode;
    this.exitOnEsc = opts.exitOnEsc !== false;
    this.allowInterject = opts.allowInterject !== false;

    // Install hotkeys immediately; allowInterject gates the 'i' hotkey.
    installHotkeys(
      {
        onEsc: () => { void this.gracefulShutdown(); },
        onCtrlC: () => { this.fastAbort(); },
        onInterject: () => { if (this.allowInterject) void this.enterInterjection(); },
      },
      { interjectKey: this.interjectKey, allowInterject: this.allowInterject }
    );
  }

  attachScheduler(s: RandomScheduler) { this.scheduler = s; }

  // --------------------------------------------------------------------------
  // Public API used by app/scheduler
  // --------------------------------------------------------------------------

  async askInitialAndSend(initial?: string | boolean) {
    if (!this.scheduler) return;
    if (typeof initial === "string" && initial.trim()) {
      (this.scheduler as any).interject?.(initial.trim());
      return;
    }
    if (initial === true && this.allowInterject) {
      const text = await this.runReadlineOnce(this.interjectBanner);
      if (text && text.trim()) (this.scheduler as any).interject?.(text.trim());
    }
  }

  /**
   * When a model asks the user a question.
   * In non-interactive mode we just return null (no prompt).
   */
  askUser = async (fromAgent: string, content: string): Promise<string | null> => {
    if (!this.allowInterject) return null;
    const promptText = this.promptTemplate(fromAgent, content);
    const text = await this.runReadlineOnce(promptText);
    return (text ?? "").trim() || null;
  };

  // --------------------------------------------------------------------------
  // Interjection flow
  // --------------------------------------------------------------------------

  private async enterInterjection(): Promise<void> {
    if (!this.allowInterject) return;

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

      // Hotkeys OFF while readline is active (restore cooked/echo).
      suspendHotkeys();

      // Create readline (cooked mode; kernel echo & line editing).
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

      this.rl.question(ask, (answer) => {
        resolve((answer ?? "").trim());
      });

      // Cleanup after question completes.
      const finish = () => {
        try { this.rl?.close(); resumeStdin(); } catch (e) { Logger.error(e); }
        this.rl = null;
        this.interjecting = false;
        // Hotkeys back ON (raw/no-echo idle).
        resumeHotkeys();
      };
      this.rl.once("close", finish);
      this.rl.once("SIGINT", finish);
    });
  }

  // --------------------------------------------------------------------------
  // Shutdown flows
  // --------------------------------------------------------------------------

  private fastAbort() {
    // Fast abort; do NOT finalize (user wanted instant cancel)
    if (!this.testMode && this.exitOnEsc) {
      try { suspendHotkeys(); } catch {}
      process.stdout.write("\n");
      process.exit(130);
    }
  }

  private async gracefulShutdown(): Promise<void> {
    try { suspendHotkeys(); } catch {}
    try { await this.scheduler?.stop?.(); } catch (e) { Logger.error(e); }

    const willExitHere = !this.testMode && this.exitOnEsc;
    if (this.escFinalizer) {
      try { await this.escFinalizer(); } catch (e) { Logger.error(e); }
    } else if (willExitHere) {
      try { await finalizeAllSandboxes(); } catch (e) { Logger.error(e); }
    }

    if (willExitHere) {
      process.stdout.write("\n");
      process.exit(0);
    } else {
      // If we’re not exiting (e.g., tests), re-arm hotkeys.
      try { resumeHotkeys(); } catch {}
    }
  }

  // --------------------------------------------------------------------------
  // Test helper surface (sync path – no debounce)
  // --------------------------------------------------------------------------
  public readonly _private = {
    /**
     * Synchronous synthetic key for tests.
     * - { name: "escape" } → gracefulShutdown()
     * - { name: "c", ctrl: true } → fastAbort()
     * - { name: <interjectKey> } → enterInterjection()
     */
    emitKey: (k: { name: string; ctrl?: boolean }) => {
      const name = (k?.name || "").toLowerCase();
      if (name === "escape" || name === "esc") { void this.gracefulShutdown(); return; }
      if (k?.ctrl && name === "c") { this.fastAbort(); return; }
      if (name === this.interjectKey) { void this.enterInterjection(); return; }
      // also forward to runtime test hook (harmless in tests)
      try { _emitForTests(k as any); } catch {}
    },
  };
}

// Backward-compat alias and default export
export const Controller = InputController;
export default InputController;

/* ------------------------------------------------------------------------- */
/* Test helper the suite expects                                             */
/* ------------------------------------------------------------------------- */
export function makeControllerForTests(args: {
  scheduler: RandomScheduler;
  finalizer?: () => void | Promise<void>;
  allowInterject?: boolean;
}) {
  const c = new InputController({
    _testMode: true,
    finalizer: args.finalizer,
    allowInterject: args.allowInterject !== false,
  });
  c.attachScheduler(args.scheduler);
  return c;
}
