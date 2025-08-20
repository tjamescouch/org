import * as readline from "node:readline";
import { RoundRobinScheduler } from "../scheduler";
import { Logger } from "../logger";
import { InputState } from "./types";
import { dbg, enableRawMode, disableRawMode, resumeStdin, isRaw } from "./utils";

/**
 * Single-owner stdin controller:
 * - Only ONE consumer reads stdin at a time (raw key handler OR readline.question).
 * - While prompting, the raw 'data' listener is detached to prevent duplication.
 * - Interjections are routed via the same path as normal user messages.
 */
export class InputController {
  private rl: readline.Interface;
  private scheduler: RoundRobinScheduler;

  private rawHandler: ((chunk: Buffer) => void) | null = null;
  private state: InputState = InputState.Idle;
  private destroyed = false;

  constructor(scheduler: RoundRobinScheduler) {
    this.scheduler = scheduler;
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "" });
  }

  /** Initialize keyboard handlers (raw-mode hotkeys + SIGINT). */
  init() {
    resumeStdin();
    if (process.stdin.isTTY) {
      try { enableRawMode(); } catch (e) { Logger.error(e) }
      this.rawHandler = (chunk: Buffer) => this.onKeyData(chunk);
      process.stdin.on("data", this.rawHandler);
    }
    process.on("SIGINT", () => this.shutdown());
    process.stdin.on("pause", () => dbg("stdin paused"));
    process.stdin.on("resume", () => dbg("stdin resumed"));
  }

  /** Ask the user for a line with exclusive ownership of stdin. */
  private async askLineExclusive(prompt: string): Promise<string> {
    // Detach raw handler; ensure cooked mode; then question; then restore.
    const hadRaw = isRaw();
    if (this.rawHandler) process.stdin.off("data", this.rawHandler);
    if (hadRaw) disableRawMode();

    const answer = await new Promise<string>((resolve) => {
      try {
        this.rl.question(prompt, (ans) => resolve(ans ?? ""));
      } catch (e) {
        dbg("rl.question error; recreating readline:", e);
        try { this.rl.close(); } catch (e) { Logger.error(e) }
        this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "" });
        this.rl.question(prompt, (ans) => resolve(ans ?? ""));
      }
    });

    if (hadRaw) enableRawMode();
    if (this.rawHandler) process.stdin.on("data", this.rawHandler);
    resumeStdin();
    return answer ?? "";
  }

  /** Public helper used by scheduler for @@user. */
  async provideToScheduler(_fromAgent: string, _content: string): Promise<string | null> {
    if (this.state !== InputState.Idle) {
      dbg("provideToScheduler requested while state=", this.state);
    }
    this.state = InputState.Prompt;
    try {
      const line = await this.askLineExclusive("user: ");
      return line;
    } finally {
      this.state = InputState.Idle;
    }
  }

  /** First prompt at program start (or injected initial). */
  async askInitialAndSend(prompt?: string) {
    const initial = prompt ?? (await this.askUserOnce("user: "));
    const trimmed = (initial || "").trim();
    if (trimmed) this.scheduler.handleUserInterjection(trimmed);
  }

  /** Ask once (used by init path). Owns stdin exclusively while asking. */
  private async askUserOnce(prompt: string): Promise<string> {
    this.state = InputState.Prompt;
    try {
      const line = await this.askLineExclusive(prompt);
      return line;
    } finally {
      this.state = InputState.Idle;
    }
  }

  /** Raw key handler (only active when in raw mode and state=Idle). */
  private async onKeyData(buf: Buffer) {
    if (this.destroyed) return;
    if (!isRaw()) return;                     // ignore if not in raw mode
    if (this.state !== InputState.Idle) return; // another prompt already active

    const ch = buf.toString("utf8");
    const code = buf[0];

    // Ctrl+C
    if (code === 3) { this.shutdown(); return; }

    // Hotkey: 'i' or 'I' to interject
    if (ch === "i" || ch === "I") {
      this.state = InputState.Interject;
      try {
        this.scheduler.pause();
        Logger.warn("Waiting for agent to complete...");
        await this.scheduler.drain();
        const text = await this.askLineExclusive("interject (user): ");
        const trimmed = (text || "").trim();
        dbg("interject line:", JSON.stringify(trimmed));
        if (trimmed) this.scheduler.handleUserInterjection(trimmed);
      } catch (e) {
        Logger.error(`interject failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.scheduler.resume();
        this.state = InputState.Idle;
      }
      return;
    }
  }

  /** Graceful shutdown on SIGINT. */
  shutdown() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.state = InputState.ShuttingDown;
    try {
      if (process.stdin.isTTY) {
        try { disableRawMode(); } catch (e) { Logger.error(e) }
        if (this.rawHandler) process.stdin.off("data", this.rawHandler);
      }
    } catch (e) { Logger.error(e) }
    try { this.rl.close(); } catch (e) { Logger.error(e) }
    process.exit(0);
  }
}
