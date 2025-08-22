// src/controller.ts
/**
 * Input controller that guarantees keystrokes are NOT echoed unless
 * we are actively capturing user text (interjection or scheduler prompt).
 *
 * - Idle: raw TTY, no echo. We listen for a hotkey (default "i") to interject.
 * - Prompting: canonical line mode via readline, echo ON, line editing enabled.
 *   After submit, we restore raw/no-echo and reattach the hotkey listener.
 *
 * This file exports `InputController` and keeps a `Controller` alias for
 * compatibility in case other files refer to it by the old name.
 */

import * as readline from "readline";
import { Logger } from "../logger";
import type { RandomScheduler } from "../scheduler";
import { resumeStdin } from "./utils";

export type InputControllerOptions = {
  interjectKey?: string;         // default: "i"
  interjectBanner?: string;      // default: "You: "
  promptTemplate?: (from: string, content: string) => string; // when a model asks the user
};

export class InputController {
  private interjectKey: string;
  private interjectBanner: string;
  private promptTemplate: (from: string, content: string) => string;

  private scheduler: RandomScheduler | null = null;

  private rl: readline.Interface | null = null;
  private interjecting = false;

  private keypressHandler?: (str: string, key: readline.Key) => void;

  constructor(opts: InputControllerOptions = {}) {
    this.interjectKey = (opts.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts.interjectBanner ?? "You: ";
    this.promptTemplate =
      opts.promptTemplate ??
      ((from, content) => `\n@@${from} requested input\n${content}\nYou: `);

    // Put stdin into raw/no-echo immediately (if TTY).
    this.setRawMode(true);
    this.installRawKeyListener();

    // Clean exit guard to avoid leaving the terminal in raw mode.
    process.on("SIGINT", () => {
      this.detachRawKeyListener();
      this.setRawMode(false);
      process.stdout.write("\n");
      process.exit(0);
    });
  }

  attachScheduler(s: RandomScheduler) {
    this.scheduler = s;
  }

  /**
   * Called by app on startup to seed the conversation. If `initial` is given,
   * we broadcast it using the scheduler’s existing fan‑out behavior.
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
          this.setRawMode(true);
          this.installRawKeyListener(); // re-attach idle hotkeys
        }
      });
    });
  }

  // --------------------------------------------------------------------------
  // Raw key handling (no echo)
  // --------------------------------------------------------------------------

  private installRawKeyListener() {
    if (this.keypressHandler) return; // already installed
    readline.emitKeypressEvents(process.stdin);

    this.keypressHandler = (_str: string, key: readline.Key) => {
      if (this.interjecting) return; // readline is active; ignore raw keys
      if (!key) return;

      // Ctrl+C exits (restore terminal first).
      if (key.ctrl && key.name === "c") {
        this.detachRawKeyListener();
        this.setRawMode(false);
        process.stdout.write("\n");
        process.exit(0);
      }

      // Single-key, case-insensitive interjection hotkey.
      const name = (key.name || "").toLowerCase();
      if (name === this.interjectKey) {
        // Kick off interjection capture (echo on inside).
        this.enterInterjection().catch((err) => Logger.error(err));
      }
    };

    // Important: put stdin into raw to prevent kernel echo while idle.
    this.setRawMode(true);
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
