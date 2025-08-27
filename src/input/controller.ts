/* eslint-disable no-console */
/**
 * InputController — a tiny, explicit FSM for terminal input.
 *
 * - While IDLE we keep TTY raw/no-echo and listen for ESC / hotkey / first char.
 * - When prompting we switch to readline (cooked, echo ON) and there is exactly
 *   one canonical echo (no double echo).
 * - Deterministic transitions and no handler leaks.
 */

import * as readline from "readline";
import { Logger } from "../logger";

// ---------- local TTY helpers ----------
function setRaw(on: boolean) {
  if (process.stdin.isTTY) {
    try { (process.stdin as any).setRawMode?.(on); } catch { /* ignore */ }
  }
}
function resumeTTY() { try { process.stdin.resume(); } catch {} }
function pauseTTY()  { try { process.stdin.pause(); }  catch {} }

function trace(msg: string) {
  if (process.env.ORG_DEBUG === "1" || process.env.DEBUG === "1") {
    process.stderr.write(`[input-fsm] ${msg}\n`);
  }
}

function isPrintableByte(b: number) {
  return b !== 0x1b && b !== 0x0d && b !== 0x0a; // ESC/CR/LF
}
function isPrintable(buf: Buffer) {
  if (!buf || buf.length === 0) return false;
  for (const b of buf.values()) if (!isPrintableByte(b)) return false;
  return true;
}

// ---------- types ----------
type Finalizer = () => Promise<void> | void;
export interface InputControllerOpts {
  interjectKey?: string;     // default "i"
  interjectBanner?: string;  // default "You: "
  exitOnEsc?: boolean;       // default true
  finalizer?: Finalizer;     // graceful finalize when ESC in idle
}
type SubmitFn = (text: string) => Promise<void> | void;

type State =
  | { name: "idle" }
  | { name: "interject"; who?: string; prompt?: string };

export class InputController {
  private state: State = { name: "idle" };

  private readonly interjectKey: string;
  private readonly banner: string;
  private readonly exitOnEsc: boolean;
  private readonly finalizer: Finalizer;

  private dataHandler?: (chunk: Buffer) => void;
  private submit?: SubmitFn;
  private interjectActive = false;      // re-entry guard
  private warnedSubmit = false;         // one-time warn if no submit target

  constructor(opts: InputControllerOpts = {}) {
    this.interjectKey = String(opts.interjectKey ?? "i");
    this.banner = String(opts.interjectBanner ?? "You: ");
    this.exitOnEsc = opts.exitOnEsc !== false;
    this.finalizer = opts.finalizer ?? (async () => { /* noop */ });

    resumeTTY();
    this.enterIdle();
  }

  // ---------- wiring ----------
  attachScheduler(scheduler: any) {
    // Try a bunch of common names to avoid rewiring app.ts.
    const candidates = [
      "onUserInput",
      "receiveUser", "receiveUserInput", "receiveInput",
      "submitUser", "submitUserText",
      "enqueueUser", "enqueueUserText", "enqueueInput",
      "acceptUser", "acceptUserInput",
      "pushUserText", "sendUserText",
      "handleUserInput", "ingestUserInput",
      "submit", "enqueue", "receive",
    ];

    for (const name of candidates) {
      if (typeof scheduler?.[name] === "function") {
        this.submit = (text) => scheduler[name](text);
        trace(`attachScheduler: using scheduler.${name}(text)`);
        return;
      }
    }

    if (typeof scheduler?.emit === "function") {
      this.submit = (text) => scheduler.emit("user", text);
      trace(`attachScheduler: using scheduler.emit("user", text)`);
      return;
    }

    // Fallback: keep a stub but warn once.
    this.submit = async (text) => {
      if (!this.warnedSubmit) {
        this.warnedSubmit = true;
        Logger.info(
          "[warn] InputController could not find a scheduler submit method. " +
          "User text will not be delivered."
        );
      }
      Logger.info(`[user -> @@group] ${text}`);
    };
    trace("attachScheduler: no submit target found (stub)");
  }

  async askInitialAndSend(kickoff?: string | boolean) {
    if (kickoff === true) {
      await this.openInterject({ who: "@scheduler", prompt: "requested input" });
    } else if (typeof kickoff === "string" && kickoff.length > 0) {
      Logger.info(`[user -> @@group] ${kickoff}`);
      await this.submit?.(kickoff);
    }
  }

  async askUser(fromAgent: string, content: string) {
    Logger.info(`@@${fromAgent} requested input`);
    await this.openInterject({ who: `@${fromAgent}`, prompt: content });
  }

  // ---------- FSM ----------
  private setState(s: State) {
    trace(`state -> ${s.name}`);
    this.state = s;
  }

  private removeIdleHandler() {
    if (this.dataHandler) {
      process.stdin.off("data", this.dataHandler);
      this.dataHandler = undefined;
    }
  }

  private enterIdle() {
    this.setState({ name: "idle" });
    this.interjectActive = false;
    pauseTTY();
    resumeTTY();
    setRaw(true);
    this.removeIdleHandler();

    this.dataHandler = (chunk: Buffer) => {
      const s = chunk.toString("binary");
      // Let SIGINT propagate
      if (s === "\x03") return;

      // ESC from idle => graceful finalize
      if (s === "\x1b") {
        if (this.exitOnEsc) {
          setRaw(false);
          this.removeIdleHandler();
          Promise.resolve(this.finalizer()).catch((e) => Logger.info(e));
        }
        return;
      }

      // explicit hotkey
      if (s === this.interjectKey) {
        this.removeIdleHandler();
        void this.openInterject({});
        return;
      }

      // printable seed opens prompt
      if (isPrintable(chunk)) {
        this.removeIdleHandler();
        void this.openInterject({}, chunk);
      }
    };

    process.stdin.on("data", this.dataHandler);
  }

  private async openInterject(ctx: { who?: string; prompt?: string }, seed?: Buffer) {
    // *** FIX 1: detach IDLE listener always and guard re-entry ***
    this.removeIdleHandler();
    if (this.interjectActive) {
      trace("openInterject: already active (ignoring)");
      return;
    }
    this.interjectActive = true;

    this.setState({ name: "interject", ...ctx });

    setRaw(false); // cooked echo
    resumeTTY();

    if (ctx.who) {
      const meta = ctx.prompt ? ` ${ctx.prompt}` : "";
      Logger.info(`[user -> @@${ctx.who}]${meta}`);
    }

    // One visible prompt; readline provides the *only* echo.
    process.stdout.write(`${this.banner}`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 0,
      prompt: "",
    });

    // ESC cancels current prompt
    let canceled = false;
    const escListener = (buf: Buffer) => {
      if (buf && buf.length && buf[0] === 0x1b) {
        canceled = true;
        rl.write("", { name: "return" } as any);
      }
    };
    (rl.input as any).on("data", escListener);

    if (seed && seed.length) {
      // raw state had no echo, so seeding is safe (no double echo)
      rl.write(seed.toString("utf8"));
    }

    const answer: string = await new Promise((resolve) => {
      rl.once("line", (line) => resolve(String(line ?? "")));
      rl.once("close", () => resolve(""));
    });

    (rl.input as any).off("data", escListener);
    rl.close();

    // single newline after closing readline
    process.stdout.write("\n");

    if (!canceled && answer.trim().length > 0) {
      Logger.info(`[user -> @@group] ${answer}`);
      await this.submit?.(answer);
    }

    // back to idle
    this.enterIdle();
  }
}
