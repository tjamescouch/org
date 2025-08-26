// src/cli/args.ts
import { Logger } from "../logger";

export function parseArgs(argv: string[]) {
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

export function getProjectFromArgs(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-C" || argv[i] === "--project") return argv[i + 1];
  }
  return process.env.ORG_PROJECT_DIR;
}

export function enableDebugIfRequested(args: Record<string, string | boolean>) {
  if (args["debug"] || process.env.DEBUG) {
    process.env.DEBUG = String(args["debug"] ?? process.env.DEBUG ?? "1");
    Logger.info("[DBG] debug logging enabled");
  }
}
