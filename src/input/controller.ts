// src/controller.ts
/**
 * Interactive controller that ensures keystrokes are NOT echoed unless the
 * user is actively interjecting. It uses raw TTY mode (no echo) while idle,
 * and temporarily switches to canonical line mode (echo on) only to capture
 * interjections or scheduler prompts.
 *
 * Hotkeys (when NOT interjecting):
 *   - "i"         Enter interjection mode
 *   - Ctrl+C      Exit
 *
 * Interjection capture uses readline so the user sees their typing (echo on)
 * and has line-editing. After submission we revert to raw, no-echo mode.
 */

import * as readline from "readline";
import { RoundRobinScheduler, Responder } from "../scheduler";
import { Logger } from "../logger";

type AskUser = (fromAgent: string, content: string) => Promise<string | null>;

export interface ControllerOptions {
  /** Hotkey to enter interjection mode (default: "i") */
  interjectKey?: string;
  /** Initial prompt prefix shown when the user voluntarily interjects */
  interjectBanner?: string;
}

export class Controller {
  private interjecting = false;
  private rl: readline.Interface | null = null;
  private keypressHandler?: (str: string, key: readline.Key) => void;

  private readonly interjectKey: string;
  private readonly interjectBanner: string;

  private scheduler: RoundRobinScheduler | null = null;

  constructor(opts?: ControllerOptions) {
    this.interjectKey = (opts?.interjectKey ?? "i").toLowerCase();
    this.interjectBanner = opts?.interjectBanner ?? "(interject) Type your message and press Enter:";
  }

  /**
   * Wire controller to a scheduler. We pass our askUser handler so the
   * scheduler can prompt the user when needed (idle fallback, guardrails, etc).
   */
  attachScheduler(args: {
    agents: Responder[];
    maxTools: number;
  }): RoundRobinScheduler {
    const onAskUser: AskUser = (fromAgent, content) => this.promptUser(fromAgent, content);

    this.scheduler = new RoundRobinScheduler({
      agents: args.agents,
      maxTools: args.maxTools,
      onAskUser,
    });

    // Begin listening for hotkeys in raw, no-echo mode.
    this.installRawKeyListener();
    return this.scheduler;
  }

  async start(): Promise<void> {
    if (!this.scheduler) throw new Error("Controller.start(): no scheduler attached");
    await this.scheduler.start();
  }

  // --------------------------------------------------------------------------
  // Interjection and prompt handling
  // --------------------------------------------------------------------------

  /**
   * Programmatic prompt used by the scheduler/guardrails.
   * Switches to canonical (echo) mode temporarily.
   */
  private async promptUser(_fromAgent: string, content: string): Promise<string | null> {
    return this.runReadlineOnce(content);
  }

  /**
   * Voluntary interjection triggered via hotkey.
   */
  private async enterInterjection(): Promise<void> {
    const text = await this.runReadlineOnce(this.interjectBanner);
    if (text && this.scheduler) {
      this.scheduler.handleUserInterjection(text);
    }
  }

  // Core: execute a single readline question with echo, then restore raw mode.
  private runReadlineOnce(promptText: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.interjecting) {
        resolve(null);
        return;
      }
      this.interjecting = true;

      // Detach raw keypress handling to avoid duplicate processing.
      this.detachRawKeyListener();

      // Switch to canonical (echoing) mode.
      this.setRawMode(false);

      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });

      // Print prompt on a fresh line to avoid mixing with streaming logs.
      const prompt = `\n${promptText}\n> `;
      this.rl.question(prompt, (answer: string) => {
        try {
          resolve((answer ?? "").trim());
        } finally {
          // Cleanup + restore raw no-echo mode
          this.rl?.close();
          this.rl = null;
          this.interjecting = false;
          this.setRawMode(true);
          this.installRawKeyListener(); // reattach hotkeys
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

      // Ctrl+C exits
      if (key.ctrl && key.name === "c") {
        // Restore TTY state before exiting to avoid a hosed terminal.
        this.detachRawKeyListener();
        this.setRawMode(false);
        process.stdout.write("\n");
        process.exit(0);
      }

      // Enter interjection mode on hotkey (single-key, case-insensitive)
      const name = (key.name || "").toLowerCase();
      if (name === this.interjectKey) {
        this.enterInterjection().catch((err) => Logger.error(err));
      }
    };

    if (process.stdin.isTTY) {
      this.setRawMode(true); // raw, no-echo while idle
      process.stdin.on("keypress", this.keypressHandler);
    }
  }

  private detachRawKeyListener() {
    if (!this.keypressHandler) return;
    process.stdin.removeListener("keypress", this.keypressHandler);
    this.keypressHandler = undefined;
  }

  // Keep raw mode management centralized (some tools may toggle this).
  private setRawMode(enable: boolean) {
    if (process.stdin.isTTY && typeof (process.stdin as any).setRawMode === "function") {
      try {
        (process.stdin as any).setRawMode(enable);
      } catch (e) {
        // Best-effort: on non-TTY CI environments this may throw.
      }
    }
  }
}
