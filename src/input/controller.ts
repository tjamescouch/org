// src/input/controller.ts
/**
 * Input controller that guarantees keystrokes are NOT echoed unless
 * we are actively capturing user text (interjection or scheduler prompt).
 *
 * - Idle: hotkeys (raw TTY) are active; nothing is echoed.
 * - Prompting: we temporarily switch to cooked mode with readline (echo ON),
 *   disable hotkeys, then restore raw/hotkeys on exit.
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
import {
  installHotkeys,
  disposeHotkeys,
  enable as enableHotkeys,
  disable as disableHotkeys,
} from "../runtime/hotkeys";

export type InputControllerOptions = {
  interjectKey?: string;         // default: "i"
  interjectBanner?: string;      // default: "You: "
  promptTemplate?: (from: string, content: string) => string; // when a model asks the user
  finalizer?: () => void | Promise<void>;   // optional override for tests / DI
  _testMode?: boolean;                       // when true, never process.exit(...)
  exitOnEsc?: boolean;                       // default: true
};

/* ------------------------------------------------------------------ */
/* Raw-mode helpers (separate from hotkeys so we can flip during REPL) */
/* ------------------------------------------------------------------ */

function isTTY(): boolean {
  return !!process.stdin.isTTY;
}

function isRawMode(): boolean {
  const anyStdin: any = process.stdin as any;
  return !!anyStdin?.isRaw;
}

function setRawMode(enable: boolean) {
  if (!isTTY()) return;
  const anyStdin: any = process.stdin as any;
  if (typeof anyStdin.setRawMode === "function") {
    try {
      anyStdin.setRawMode(enable);
      anyStdin.isRaw = !!enable; // remember state
    } catch { /* ignore on CI/non-tty */ }
  }
}

/* ------------------------------------------------------------------ */

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
  private hotkeysInstalled = false;

  constructor(opts: InputControllerOptions = {}) {
    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts.interjectBanner ?? "You: ";
    this.promptTemplate =
      opts.promptTemplate ??
      ((from, _content) => `\n@@${from} requested input\nYou: `);

    this.escFinalizer = opts.finalizer;
    this.testMode = !!opts._testMode;
    this.exitOnEsc = opts.exitOnEsc ?? true;

    // Install idle hotkeys only when we're on a TTY and not in test mode.
    if (isTTY() && !this.testMode) {
      installHotkeys(
        {
          onEsc: () => { void this.gracefulShutdown(); },
          onInterject: () => { void this.enterInterjection(); },
          onCtrlC: () => this.abortImmediately(),
        },
        { interjectKey: this.interjectKey }
      );
      this.hotkeysInstalled = true;
      // Ensure we start in raw to avoid echo while idle.
      setRawMode(true);
    }

    // As a safety net, restore cooked mode on process termination.
    process.once("exit", () => { try { setRawMode(false); } catch {} });
    process.once("SIGTERM", () => { try { setRawMode(false); } catch {}; if (!this.testMode) process.exit(143); });
  }

  attachScheduler(s: RandomScheduler) {
    this.scheduler = s;
  }

  /* --------------------------------------------------------------- */
  /* Public entry points used by the app / scheduler                 */
  /* --------------------------------------------------------------- */

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
    if (initial === true && isTTY()) {
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
  askUser = async (fromAgent: string, content: string): Promise<string | null> => {
    if (!isTTY()) return null; // non-interactive runs cannot prompt
    const promptText = this.promptTemplate(fromAgent, content);
    const text = await this.runReadlineOnce(promptText);
    return (text ?? "").trim() || null;
  };

  /**
   * External entry for user interjections (e.g., from a hotkey).
   * This drains the scheduler, runs one prompt, then resumes.
   */
  private async enterInterjection(): Promise<void> {
    if (!isTTY()) return;
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

  /* --------------------------------------------------------------- */
  /* Readline (cooked mode) with clean hotkeys/echo handoff          */
  /* --------------------------------------------------------------- */

  private async withCookedTTY<T>(fn: () => Promise<T> | T): Promise<T> {
    // Disable hotkeys so special keys go to readline, not our ESC handler.
    if (this.hotkeysInstalled) disableHotkeys();

    const wasRaw = isRawMode();
    if (wasRaw) setRawMode(false);

    try {
      return await fn();
    } finally {
      try { this.rl?.close(); } catch {}
      try { resumeStdin(); } catch {}
      this.rl = null;

      // Restore raw and hotkeys
      if (wasRaw) setRawMode(true);
      if (this.hotkeysInstalled) enableHotkeys();
    }
  }

  /** Perform exactly one readline question with echo on. */
  private runReadlineOnce(promptText: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.interjecting) {
        resolve(null);
        return;
      }
      this.interjecting = true;

      void this.withCookedTTY(async () => {
        // Create readline interface in terminal mode.
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
        this.interjecting = false;
      });
    });
  }

  /* --------------------------------------------------------------- */
  /* Shutdown paths                                                  */
  /* --------------------------------------------------------------- */

  private abortImmediately() {
    // Fast abort (Ctrl+C when hotkeys are enabled)
    try { if (this.hotkeysInstalled) disposeHotkeys(); } catch {}
    try { setRawMode(false); } catch {}
    if (!this.testMode) {
      process.stdout.write("\n");
      process.exit(130);
    }
  }

  private async gracefulShutdown(): Promise<void> {
    // ESC (via hotkeys) leads here.
    try { if (this.hotkeysInstalled) disposeHotkeys(); } catch {}
    try { setRawMode(false); } catch {}

    try { await this.scheduler?.stop?.(); } catch (e) { Logger.error(e); }

    const willExitHere = !this.testMode && this.exitOnEsc;
    const hasCustomFinalizer = !!this.escFinalizer;

    // Only run a finalizer if one was injected OR we’re exiting here.
    if (hasCustomFinalizer) {
      try { await this.escFinalizer!(); } catch (e) { Logger.error(e); }
    } else if (willExitHere) {
      // Old behavior remains for exit-on-ESC
      try { await finalizeAllSandboxes(); } catch (e) { Logger.error(e); }
    }

    if (willExitHere) {
      process.stdout.write("\n");
      process.exit(0);
    }
  }

  /* ----------------------------- test helpers ------------------------------ */

  // Tiny surface for tests (no reliance on process.exit, no hotkeys)
  public readonly _private = {
    async promptOnceForTests(promptText: string) {
      return await this.runReadlineOnce(promptText);
    },
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
