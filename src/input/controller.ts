/* eslint-disable no-console */
/**
 * InputController — explicit FSM for terminal input with robust scheduler binding.
 */

import * as readline from "readline";
import { Logger } from "../logger";

// ---------- TTY helpers ----------
function setRaw(on: boolean) {
  if (process.stdin.isTTY) {
    try { (process.stdin as any).setRawMode?.(on); } catch {}
  }
}
function resumeTTY() { try { process.stdin.resume(); } catch {} }
function pauseTTY()  { try { process.stdin.pause(); }  catch {} }

function dbg(msg: string) {
  if (process.env.ORG_DEBUG === "1" || process.env.DEBUG === "1") {
    process.stderr.write(`[input-fsm] ${msg}\n`);
  }
}
const DUMP = process.env.ORG_SCHEDULER_DUMP === "1";

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
  private interjectActive = false;
  private warnedSubmit = false;

  constructor(opts: InputControllerOpts = {}) {
    this.interjectKey = String(opts.interjectKey ?? "i");
    this.banner = String(opts.interjectBanner ?? "You: ");
    this.exitOnEsc = opts.exitOnEsc !== false;
    this.finalizer = opts.finalizer ?? (async () => {});

    resumeTTY();
    this.enterIdle();
  }

  /** Optional: let app set a submit function directly (escape hatch). */
  public setSubmit(fn: SubmitFn) { this.submit = fn; }

  // ---------- wiring ----------
  attachScheduler(schedulerLike: any) {
    const scheduler =
      schedulerLike?.default ??
      schedulerLike?.scheduler ??
      schedulerLike?.impl ??
      schedulerLike;

    const explicit = process.env.ORG_SCHEDULER_SUBMIT;
    if (explicit) {
      if (typeof scheduler?.[explicit] === "function") {
        this.submit = (text) => this.safeInvokeSubmit(scheduler, explicit, text);
        dbg(`attachScheduler: using explicit scheduler.${explicit}(text)`);
        return;
      }
      dbg(`attachScheduler: explicit ORG_SCHEDULER_SUBMIT=${explicit} not a function on target`);
    }

    const known = [
      "onUserInput",
      "receiveUser", "receiveUserInput", "receiveInput",
      "submitUser", "submitUserText",
      "enqueueUser", "enqueueUserText", "enqueueInput",
      "acceptUser", "acceptUserInput",
      "pushUserText", "sendUserText",
      "handleUserInput", "ingestUserInput",
      "submit", "enqueue", "receive",
    ];

    // 1) direct known names
    for (const name of known) {
      if (typeof scheduler?.[name] === "function") {
        this.submit = (text) => this.safeInvokeSubmit(scheduler, name, text);
        dbg(`attachScheduler: using scheduler.${name}(text)`);
        return;
      }
    }

    // 2) heuristic scan over own props + prototype chain
    const heuristics = this.findHeuristicSubmitNames(scheduler);
    if (DUMP) {
      process.stderr.write(
        `[input-fsm] dump: function candidates on scheduler => ${heuristics.join(", ") || "(none)"}\n`
      );
    } else {
      dbg(`attachScheduler: heuristic candidates: ${heuristics.join(", ") || "(none)"}`);
    }
    for (const name of heuristics) {
      this.submit = (text) => this.safeInvokeSubmit(scheduler, name, text);
      dbg(`attachScheduler: using heuristic scheduler.${name}(text)`);
      return;
    }

    // 3) event-emitter fallback
    if (typeof scheduler?.emit === "function") {
      this.submit = (text) => scheduler.emit("user", text);
      dbg(`attachScheduler: using scheduler.emit("user", text)`);
      return;
    }

    // 4) stub with one-time warning; do not drop text silently
    this.submit = async (text) => {
      if (!this.warnedSubmit) {
        this.warnedSubmit = true;
        Logger.info(
          "[warn] InputController could not find a scheduler submit method. User text will not be delivered.\n" +
          "       Either expose a method (e.g. receiveUserInput) or set ORG_SCHEDULER_SUBMIT=name.\n" +
          "       Tip: run with ORG_SCHEDULER_DUMP=1 to print all callable candidates."
        );
      }
      Logger.info(`[user -> @@group] ${text}`);
    };
    dbg("attachScheduler: no submit target found (stub)");
  }

  private async safeInvokeSubmit(scheduler: any, name: string, text: string) {
    const fn = scheduler?.[name];
    if (typeof fn !== "function") return;
    try {
      const r = fn.call(scheduler, text);
      if (r && typeof r.then === "function") await r;
      return;
    } catch (_err) {
      try {
        const r = fn.call(scheduler, { role: "user", content: text });
        if (r && typeof r.then === "function") await r;
        return;
      } catch (e2) {
        dbg(`submit via ${name} failed (string & object): ${String(e2)}`);
      }
    }
  }

  private findHeuristicSubmitNames(s: any): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const reUser = /(user|input|text|message)/i;
    const reVerb = /(submit|enqueue|receive|push|send|add|accept|queue|post|ingest|dispatch|route)/i;

    let p: any = s;
    for (let depth = 0; p && depth < 8; depth += 1, p = Object.getPrototypeOf(p)) {
      for (const key of Reflect.ownKeys(p)) {
        if (typeof key !== "string") continue;
        if (key === "constructor") continue;
        if (seen.has(key)) continue;
        seen.add(key);

        let v: any;
        try { v = (s as any)[key]; } catch { v = undefined; }
        if (typeof v === "function" && reUser.test(key) && reVerb.test(key)) {
          out.push(key);
        }
      }
    }
    out.sort();
    return out;
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
  private setState(s: State) { dbg(`state -> ${s.name}`); this.state = s; }

  private removeIdleHandler() {
    if (this.dataHandler) {
      process.stdin.off("data", this.dataHandler);
      this.dataHandler = undefined;
    }
  }

  private enterIdle() {
    this.setState({ name: "idle" });
    this.interjectActive = false;
    pauseTTY(); resumeTTY(); setRaw(true);
    this.removeIdleHandler();

    this.dataHandler = (chunk: Buffer) => {
      const s = chunk.toString("binary");
      if (s === "\x03") return;            // Ctrl+C -> let process handle SIGINT

      if (s === "\x1b") {                  // ESC from idle => finalize
        if (this.exitOnEsc) {
          setRaw(false); this.removeIdleHandler();
          Promise.resolve(this.finalizer()).catch((e) => Logger.info(e));
        }
        return;
      }

      if (s === this.interjectKey) {       // explicit hotkey
        this.removeIdleHandler();
        void this.openInterject({});
        return;
      }

      if (isPrintable(chunk)) {            // printable seed opens prompt
        this.removeIdleHandler();
        void this.openInterject({}, chunk);
      }
    };

    process.stdin.on("data", this.dataHandler);
  }

  private async openInterject(ctx: { who?: string; prompt?: string }, seed?: Buffer) {
    this.removeIdleHandler();
    if (this.interjectActive) return;
    this.interjectActive = true;

    this.setState({ name: "interject", ...ctx });
    setRaw(false); resumeTTY();

    if (ctx.who) {
      const meta = ctx.prompt ? ` ${ctx.prompt}` : "";
      Logger.info(`[user -> @@${ctx.who}]${meta}`);
    }

    process.stdout.write(`${this.banner}`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 0,
      prompt: "",
    });

    let canceled = false;
    const escListener = (buf: Buffer) => {
      if (buf && buf.length && buf[0] === 0x1b) {
        canceled = true;
        rl.write("", { name: "return" } as any);
      }
    };
    (rl.input as any).on("data", escListener);

    if (seed && seed.length) rl.write(seed.toString("utf8"));

    const answer: string = await new Promise((resolve) => {
      rl.once("line", (line) => resolve(String(line ?? "")));
      rl.once("close", () => resolve(""));
    });

    (rl.input as any).off("data", escListener);
    rl.close();
    process.stdout.write("\n");

    if (!canceled && answer.trim().length > 0) {
      Logger.info(`[user -> @@group] ${answer}`);
      await this.submit?.(answer);
    }

    this.enterIdle();
  }
}
