/* eslint-disable no-console */
/**
 * InputController — a tiny, explicit FSM for terminal input.
 *
 * Goals
 *  - No double-echo: while idle we keep the TTY in raw/no-echo; readline is
 *    only enabled during a prompt (which provides the single, canonical echo).
 *  - Deterministic state transitions we can reason about and test.
 *  - Keep the public surface compatible with the existing wiring:
 *      new InputController({...})
 *      input.attachScheduler(scheduler)
 *      await input.askInitialAndSend(kickoff)
 *      input.askUser(fromAgent, content)
 */

import * as readline from "readline";
import { Logger } from "../logger";
import { RandomScheduler } from "../scheduler";

// ---------- tiny TTY helpers (local so we don’t depend on other IO code) ----------
function setRaw(on: boolean) {
  if (process.stdin.isTTY) {
    try { (process.stdin as any).setRawMode?.(on); } catch { /* ignore */ }
  }
}

function resumeTTY() { try { process.stdin.resume(); } catch { /* ignore */ } }
function pauseTTY()  { try { process.stdin.pause(); }  catch { /* ignore */ } }

function trace(msg: string) {
  const on = process.env.ORG_DEBUG === "1" || process.env.DEBUG === "1";
  if (on) process.stderr.write(`[input-fsm] ${msg}\n`);
}

// Printable byte guard (exclude ESC / CR / LF)
function isPrintableByte(b: number) {
  return b !== 0x1b && b !== 0x0d && b !== 0x0a;
}
function isPrintable(buf: Buffer) {
  if (!buf || buf.length === 0) return false;
  for (const b of buf.values()) if (!isPrintableByte(b)) return false;
  return true;
}

// ---------- Types ----------
type Finalizer = () => Promise<void> | void;

export interface InputControllerOpts {
  interjectKey?: string;     // default "i"
  interjectBanner?: string;  // default "You: "
  exitOnEsc?: boolean;       // default true
  finalizer?: Finalizer;     // called when ESC from idle (graceful exit)
}

// We don’t rely on a concrete Scheduler type; we just need a "submit" sink.
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

  constructor(opts: InputControllerOpts = {}) {
    this.interjectKey = String(opts.interjectKey ?? "i");
    this.banner = String(opts.interjectBanner ?? "You: ");
    this.exitOnEsc = opts.exitOnEsc !== false;
    this.finalizer = opts.finalizer ?? (async () => { /* noop */ });

    // Start idle listeners immediately
    resumeTTY();
    this.enterIdle();
  }

  // Public: called by the scheduler wiring
  attachScheduler(scheduler: any) {
    // Be conservative: prefer an explicit submit method if present,
    // else allow embedding code to set .onUserInput on us.
    if (typeof scheduler?.receiveUser === "function") {
      this.submit = (text: string) => scheduler.receiveUser(text);
    } else if (typeof scheduler?.onUserInput === "function") {
      this.submit = (text: string) => scheduler.onUserInput(text);
    } else if (typeof scheduler?.enqueueUser === "function") {
      this.submit = (text: string) => scheduler.enqueueUser(text);
    } else {
      // Fallback: let callers set submit later via a property
      // (keeps compatibility if the project expects it).
      (this as any).submit = (t: string) => { Logger.info(`[user -> @@group] ${t}`); };
      this.submit = (t: string) => (this as any).submit(t);
    }
  }

  // Public: seed initial instruction
  async askInitialAndSend(kickoff?: string | boolean) {
    if (kickoff === true) {
      await this.openInterject({ who: "@scheduler", prompt: "requested input" });
    } else if (typeof kickoff === "string" && kickoff.length > 0) {
      Logger.info(`[user -> @@group] ${kickoff}`);
      await this.submit?.(kickoff);
    }
  }

  // Public: scheduler requests explicit user input
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
    pauseTTY(); // make sure we re-resume cleanly
    resumeTTY();
    setRaw(true);
    // ensure no handler leak
    this.removeIdleHandler();

    this.dataHandler = (chunk: Buffer) => {
      // Raw bytes; do not echo anything here.
      const s = chunk.toString("binary");

      // Ctrl+C: let Node handle SIGINT (don’t swallow)
      if (s === "\x03") return;

      // ESC — graceful exit (if enabled) when *not* in a prompt.
      if (s === "\x1b") {
        if (this.exitOnEsc) {
          // move to cooked mode so anything finalizer prints looks normal
          setRaw(false);
          this.removeIdleHandler();
          Promise.resolve(this.finalizer())
            .catch((e) => Logger.info(e))
            .finally(() => {
              // hand control back to the outer program
            });
        }
        return;
      }

      // Interject hotkey
      if (s === this.interjectKey) {
        this.removeIdleHandler();
        void this.openInterject({});
        return;
      }

      // Printable seed opens interject with the captured first character
      if (isPrintable(chunk)) {
        this.removeIdleHandler();
        void this.openInterject({}, chunk);
        return;
      }
    };

    process.stdin.on("data", this.dataHandler);
  }

  /**
   * Transition to the "interject" state. While in this state we use readline
   * which provides the *single* canonical echo. We optionally seed with an
   * initial character that triggered the transition while in raw mode.
   */
  private async openInterject(ctx: { who?: string; prompt?: string }, seed?: Buffer) {
    this.setState({ name: "interject", ...ctx });

    setRaw(false); // cooked, echo on
    resumeTTY();

    // Informative banner for humans
    if (ctx.who) {
      Logger.info(`[user -> @@${ctx.who}] ${ctx.prompt ?? ""}`.trim());
    }

    // Show a clean prompt on stdout; readline will handle echo/editing.
    process.stdout.write(`${this.banner}`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 0,
      prompt: "",
    });

    // Make ESC cancel the prompt cleanly
    let canceled = false;
    const escListener = (buf: Buffer) => {
      if (buf && buf.length && buf[0] === 0x1b) { // ESC
        canceled = true;
        rl.write("", { name: "return" } as any);
      }
    };
    (rl.input as any).on("data", escListener);

    // Seed the first char (no double-echo: raw mode had *no* echo)
    if (seed && seed.length) {
      rl.write(seed.toString("utf8"));
    }

    const answer: string = await new Promise((resolve) => {
      rl.once("line", (line) => resolve(String(line ?? "")));
      rl.once("close", () => resolve(""));
    });

    (rl.input as any).off("data", escListener);
    rl.close();

    // Print a single newline *once* after closing readline (no extra echo)
    process.stdout.write("\n");

    if (!canceled && answer.trim().length > 0) {
      Logger.info(`[user -> @@group] ${answer}`);
      await this.submit?.(answer);
    }

    // Return to idle raw/no-echo
    this.enterIdle();
  }
}


// Factory used by tests to build a controller in "test mode" (no process.exit)
export function makeControllerForTests(args: {
  scheduler: RandomScheduler;
  finalizer?: () => void | Promise<void>;
}) {
  const c = new InputController({ finalizer: args.finalizer });
  c.attachScheduler(args.scheduler);
  return c;
}