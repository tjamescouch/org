import * as readline from "node:readline";
import { RoundRobinScheduler } from "./scheduler";
import { Logger } from "./logger";

/** Handles: initial prompt, interject on 'i', and graceful Ctrl+C */
export class InputController {
  private rl: readline.Interface;
  private scheduler: RoundRobinScheduler;
  private rawHandler: ((chunk: Buffer) => void) | null = null;
  private busy = false;

  constructor(scheduler: RoundRobinScheduler) {
    this.scheduler = scheduler;
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  init() {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
      } catch {}
      this.rawHandler = (chunk: Buffer) => this.onKeyData(chunk);
      process.stdin.on("data", this.rawHandler);
    }
    // Ctrl+C handling via readline too
    this.rl.on("SIGINT", () => this.shutdown());
  }

  /** Ask the user for a line; used both for initial prompt and @@user replies. */
  async askLine(prompt = "user: "): Promise<string> {
    // Temporarily disable raw mode so readline behaves normally
    const wasRaw = !!(process.stdin as any).isRaw;
    if (wasRaw) try { process.stdin.setRawMode(false); } catch {}
    const ans = await new Promise<string>((resolve) => this.rl.question(prompt, resolve));
    if (wasRaw) try { process.stdin.setRawMode(true); } catch {}
    return ans || "";
  }

  /** Called by scheduler when an agent addressed @@user */
  provideToScheduler = async (_fromAgent: string, _content: string): Promise<string | null> => {
    this.busy = true;
    try {
      const line = await this.askLine("user: ");
      return line;
    } finally {
      this.busy = false;
    }
  };

  /** Convenience: get the first user prompt and feed it. */
  async askInitialAndSend() {
    const line = await this.askLine("user: ");
    if (line.trim()) this.scheduler.handleUserInterjection(line.trim());
  }

  private async onKeyData(buf: Buffer) {
    const ch = buf.toString("utf8");
    const code = buf[0];

    // Ctrl+C
    if (code === 3) { // ^C
      this.shutdown();
      return;
    }

    // Ignore while already prompting
    if (this.busy) return;

    // Hotkey: 'i' or 'I'
    if (ch === "i" || ch === "I") {
      this.busy = true;
      try {
        this.scheduler.pause();
        const text = await this.askLine("interject (user): ");
        const trimmed = text.trim();
        if (trimmed) this.scheduler.handleUserInterjection(trimmed);
      } catch (e) {
        Logger.error(`interject failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.scheduler.resume();
        this.busy = false;
      }
      return;
    }
  }

  shutdown() {
    try {
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
        if (this.rawHandler) process.stdin.off("data", this.rawHandler);
      }
    } catch {}
    this.rl.close();
    process.exit(0);
  }
}
