// test/helpers/run-org.ts
import { spawn } from "child_process";
import * as path from "path";
import { runSh as sh } from "../src/tools/sh";

export type RunOpts = {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  args?: string[];              // extra args already tokenized
};

export type RunResult = { code: number; out: string; err: string };

/**
 * Spawns `org` (actually bun + src/app.ts) in a *new process group* so we can
 * kill the whole tree (SIGTERM then SIGKILL) on timeout or cleanup.
 *
 * - Forces console UI & quiet logging for tests
 * - Captures stdout/stderr
 * - Enforces a timeout
 */
export function runOrg(cwd: string, cli: string, opts: RunOpts = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 4500;

  // entry -> src/app.ts (keeps tests independent of the installed shim)
  const entry = path.resolve(__dirname, "../../src/app.ts");
  const bun = process.execPath; // running under Bun; this is bun's absolute path

  // Tokenize simple CLI string into argv pieces (tolerant for tests)
  const extra = opts.args ?? splitArgs(cli);

  const env = {
    ...process.env,
    ORG_FORCE_UI: "console",
    ORG_LOG_LEVEL: "error",
    ORG_TEST_RUN: "1",          // marker so global cleanup can find us
    ...opts.env,
  };

  const child = spawn(bun, [entry, ...extra], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,             // new process group -> kill(-pid)
  });

  let out = "", err = "";

  child.stdout.on("data", (b) => (out += b.toString()));
  child.stderr.on("data", (b) => (err += b.toString()));

  const killTree = (sig: NodeJS.Signals = "SIGTERM") => {
    if (!child.pid) return;
    try { process.kill(-child.pid, sig); } catch { /* ignored */ }
  };

  const timer = setTimeout(() => {
    err += `\n[TEST] timeout ${timeoutMs}ms -> killing process group\n`;
    killTree("SIGTERM");
    // brutal fallback if still alive in 300ms
    setTimeout(() => killTree("SIGKILL"), 300);
  }, timeoutMs);

  return new Promise<RunResult>((resolve) => {
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

// --- tiny tolerant arg splitter for tests (not a full shell parser) ---
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "", q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else cur += c;
    } else {
      if (c === "'" || c === '"') q = c as any;
      else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } }
      else cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function lastRunDir(repo: string): Promise<string | null> {
  const { stdout: out } = await sh("ls -td .org/runs/* 2>/dev/null | head -n1");
  const s = out.trim();
  return s.length ? s : null;
}
