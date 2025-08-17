import * as readline from "node:readline";
import { RoundRobinScheduler } from "./scheduler";
import { Logger } from "./logger";

const DEBUG = (() => {
  const v = (process.env.DEBUG ?? "").toString().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "debug";
})();
function dbg(...a: any[]) { if (DEBUG) Logger.info("[DBG][input]", ...a); }

export class InputController {
  private rl: readline.Interface;
  private scheduler: RoundRobinScheduler;
  private rawHandler: ((chunk: Buffer) => void) | null = null;
  private busy = false;

  constructor(scheduler: RoundRobinScheduler) {
    this.scheduler = scheduler;
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "" });
  }

  init() {
    try { process.stdin.resume(); } catch {}
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch {}
      this.rawHandler = (chunk: Buffer) => this.onKeyData(chunk);
      process.stdin.on("data", this.rawHandler);
    }

    process.on("SIGINT", () => { this.shutdown(); });
    process.stdin.on("pause", () => dbg("stdin paused"));
    process.stdin.on("resume", () => dbg("stdin resumed"));
  }

  async askLine(prompt = "user: "): Promise<string> {
    const wasRaw = !!(process.stdin as any).isRaw;
    if (wasRaw) try { process.stdin.setRawMode(false); } catch {}
    const line = await new Promise<string>((resolve) => {
      this.rl.question(prompt, (ans) => resolve(ans ?? ""));
    });
    if (wasRaw) try { process.stdin.setRawMode(true); } catch {}
    try { process.stdin.resume(); } catch {}
    return line || "";
  }

  async provideToScheduler(_fromAgent: string, _content: string): Promise<string | null> {
    this.busy = true;
    try { return await this.askLine("user: "); }
    finally { this.busy = false; }
  }

  async askInitialAndSend(prompt?: string) {
    const line = prompt || await this.askLine("user: ");
    if (line.trim()) this.scheduler.handleUserInterjection(line.trim());
  }

  private async onKeyData(buf: Buffer) {
    if (!(process.stdin as any).isRaw) return;
    const ch = buf.toString("utf8");
    const code = buf[0];
    if (code === 3) { this.shutdown(); return; }
    if (this.busy) return;
    if (ch === "i" || ch === "I") {
      this.busy = true;
      try {
        this.scheduler.pause();
        const text = await this.askLine("interject (user): ");
        if (text.trim()) this.scheduler.handleUserInterjection(text.trim());
      } catch (e) { Logger.error(`interject failed: ${e}`); }
      finally { this.scheduler.resume(); this.busy = false; }
    }
  }

  shutdown() {
    try {
      if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
      if (this.rawHandler) process.stdin.off("data", this.rawHandler);
    } catch {}
    try { this.rl.close(); } catch {}
    process.exit(0);
  }
}
