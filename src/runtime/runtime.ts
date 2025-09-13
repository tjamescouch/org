// A single place where we "touch" globalThis.process / globalThis.Bun.
// We intentionally cast to any here so the rest of the codebase never
// needs @types/node or bun types if you don't want them.

import { TtyController } from "../input/tty-controller";
import { Logger } from "../logger";

type Env = Record<string, string | undefined>;

type RuntimeName = "bun" | "node" | "unknown";


interface Runtime {
  args: Record<string, string | boolean>,

  ttyController?: TtyController | undefined;

  isPretty(): boolean;
  isInteractive(): boolean;

  /** Which runtime we detected */
  name: RuntimeName;

  /** Command-line arguments (no need to slice, these are the "real" argv) */
  argv: string[];

  /** Environment variables (readonly snapshot) */
  env: Env;

  /** Current working directory */
  cwd(): string;

  /** Exit the process */
  exit(code?: number): never;

  /** Basic TTY signal (stdout by default) */
  isTTY: boolean;

  /** Streams (if present); when not available, they are harmless no-ops */
  stdin: any;   // NodeJS.ReadStream | ReadableStream<Uint8Array> | undefined
  stdout: any;  // NodeJS.WriteStream | WritableStream | undefined
  stderr: any;

  /** Minimal process-like 'on' for events you already use */
  on(event: "beforeExit" | "uncaughtException" | "unhandledRejection" | "SIGINT" | "SIGTERM",
    handler: (...args: any[]) => void): void;

  /** Remove listener; no-op if unsupported */
  off(event: string, handler: (...args: any[]) => void): void;
}

function makeRuntime(): Runtime {
  const g: any = globalThis as any;
  const hasBun = !!g.Bun;
  const hasProc = !!g.process;

  // Prefer Bun argv if present; otherwise Node's process.argv.
  const argvFull: string[] =
    hasBun ? (g.Bun.argv as string[]) :
      hasProc ? (g.process.argv as string[]) :
        [];

  // We expose argv without the runtime + script bits (i.e., same slice you use)
  const argv = argvFull.slice(2);

  const env: Env =
    hasBun ? (g.Bun.env as Env) :
      hasProc ? (g.process.env as Env) :
        {};

  const isTTY =
    (hasProc && g.process.stdout && !!g.process.stdout.isTTY) ||
    (hasProc && g.process.stderr && !!g.process.stderr.isTTY) ||
    false;

  const name: RuntimeName =
    hasBun ? "bun" :
      hasProc ? "node" :
        "unknown";

  // Functions we call defensively
  const cwd = () => {
    if (hasProc && typeof g.process.cwd === "function") return g.process.cwd();
    if (hasBun && g.Bun && typeof g.Bun.cwd === "function") return g.Bun.cwd();
    try { return (g.Deno?.cwd?.() as string) ?? "/"; } catch { return "/"; }
  };

  const exit = (code?: number): never => {
    if (hasProc && typeof g.process.exit === "function") {
      g.process.exit(code ?? 0);
      // satisfy TS never
      throw new Error("process.exit returned");
    }
    if (hasBun && g.Bun?.exit) {
      g.Bun.exit(code ?? 0);
      throw new Error("Bun.exit returned");
    }
    // As a last resort:
    throw Object.assign(new Error("No exit available"), { code: code ?? 0 });
  };

  const on = (
    event: "beforeExit" | "uncaughtException" | "unhandledRejection" | "SIGINT" | "SIGTERM",
    handler: (...args: any[]) => void,
  ) => {
    if (hasProc && typeof g.process.on === "function") {
      g.process.on(event, handler);
      return;
    }
    // No-op in other environments
  };

  const off = (event: string, handler: (...args: any[]) => void) => {
    if (hasProc && typeof g.process.off === "function") {
      g.process.off(event, handler);
      return;
    }
    if (hasProc && typeof g.process.removeListener === "function") {
      g.process.removeListener(event, handler);
    }
  };

  Logger.debug(env);

  const args = parseArgs(argv);

  return {
    isInteractive(): boolean {
      return !(args["prompt"]);
    },
    args,
    name,
    argv,
    env,
    isPretty(): boolean {
      return this.env.ORG_UI_MODE === "tmux" || this.env.ORG_UI_MODE === "rich";
    },
    cwd,
    exit,
    isTTY,
    stdin: hasProc ? g.process.stdin : undefined,
    stdout: hasProc ? g.process.stdout : undefined,
    stderr: hasProc ? g.process.stderr : undefined,
    on,
    off,
  };
}

// Export a single instance used everywhere.
export const R: Runtime = makeRuntime();

// Convenience re-exports if you like short imports:
export const { } = R;


// ───────────────────────────────────────────────────────────────────────────────
// Args & config
// ───────────────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  let key: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (typeof v === "string") out[k] = v;
      else { key = k; out[k] = true; }
    } else if (key) {
      out[key] = a; key = null;
    } else {
      if (!("prompt" in out)) out["prompt"] = a;
      else out[`arg${Object.keys(out).length}`] = a;
    }
  }
  return out;
}