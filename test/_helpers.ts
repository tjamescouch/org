// test/_helpers.ts
// Unified test helpers used by e2e tests.
// This file restores missing exports expected by the suite:
//   - initRepo()
//   - runOrg()               (synchronous; returns { code, out, err })
//   - lastRunDir()           (synchronous)
//   - readFileSafe()         (synchronous; cats file or runs a safe shell)
//   - patchSize()
//   - sh                      (re-export of src/tools/sh.runSh)

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runSh as sh } from "../src/tools/sh";

export type RunOpts = {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  args?: string[];              // extra args already tokenized
};

export type RunResult = { code: number; out: string; err: string };

// Export the raw shell helper for tests that need it.
export { sh };

/** Create a temporary git repo, make an initial commit, and return its path. */
export function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "org-repo-"));
  const run = (cmd: string) =>
    spawnSync("bash", ["-lc", cmd], { cwd: dir, stdio: "pipe" });

  // Basic git repo with one file committed.
  run("git init -q");
  run('git config user.email "test@example.com"');
  run('git config user.name "Org Tests"');
  writeFileSync(join(dir, "README.md"), "# org-test\n");
  run("git add -A");
  run('git commit -qm "init"');

  // Ensure .org exists for runtime artifacts.
  try { writeFileSync(join(dir, ".gitignore"), ".org/\n", { flag: "a" }); } catch {}
  return dir;
}

/** Tokenize a simple CLI string into argv pieces, respecting quotes. */
function splitArgs(cli: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: "'" | '"' | null = null;
  for (let i = 0; i < cli.length; i++) {
    const c = cli[i];
    if (q) {
      if (c === q) { q = null; }
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c as any; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Spawns `org` (bun + src/app.ts) synchronously.
 * - Forces console UI & quiet logging for tests
 */
export function runOrg(cwd: string, cli: string, opts: RunOpts = {}): RunResult {
  const timeoutMs = opts.timeoutMs ?? 4500;

  // entry -> src/app.ts (keeps tests independent of the installed shim)
  const entry = resolve(__dirname, "../src/app.ts");
  const bun = process.execPath; // running under Bun; this is bun's absolute path

  // Tokenize CLI into argv pieces
  const extra = opts.args ?? splitArgs(cli);

  const env = {
    ...process.env,
    ORG_FORCE_UI: "console",
    ORG_LOG_LEVEL: "error",
    ...opts.env,
  };

  // Build argv and spawn synchronously; Bun compiles TS entry automatically.
  const argv = [entry, ...extra];

  // To enforce a timeout while using spawnSync, run under bash with timeout.
  // Use `timeout` if available; otherwise fall back to plain execution.
  const timeoutPrefix = "command -v timeout >/dev/null 2>&1 && timeout -k 0 " + Math.ceil(timeoutMs/1000) + " ";
  const cmd = `${timeoutPrefix}${JSON.stringify(bun)} ${argv.map(a => JSON.stringify(a)).join(" ")}`;

  const r = spawnSync("bash", ["-lc", cmd], { cwd, env, stdio: "pipe", encoding: "utf8" });

  const out = r.stdout?.toString?.() ?? String(r.stdout ?? "");
  const err = r.stderr?.toString?.() ?? String(r.stderr ?? "");
  const code = typeof r.status === "number" ? r.status : (typeof r.signal === "string" ? 130 : -1);

  return { code, out, err };
}

/** Return the newest `.org/runs/<id>` directory path (relative to repo) or null. */
export function lastRunDir(repo: string): string | null {
  const base = join(repo, ".org", "runs");
  try {
    const names = readdirSync(base);
    const dirs = names
      .map(n => ({ n, p: join(base, n), st: statSync(join(base, n)) }))
      .filter(x => x.st.isDirectory())
      .sort((a,b) => b.st.mtimeMs - a.st.mtimeMs);
    if (!dirs.length) return null;
    // return relative path like ".org/runs/<id>" to match tests constructing `${run}/session.patch`
    const rel = join(".org", "runs", dirs[0].n);
    return rel;
  } catch {
    return null;
  }
}

/**
 * Read a file's contents inside `repo` safely. If `target` looks like
 * a shell command (starts with "ls " or contains wildcards), execute it and
 * return stdout; otherwise, treat it as a file path and return its text.
 * Returns "" on failure.
 */
export function readFileSafe(repo: string, target: string): string {
  try {
    const looksLikeCmd = /^\s*(ls|cat)\b/.test(target) || /[*?{|]/.test(target);
    if (looksLikeCmd) {
      const r = spawnSync("bash", ["-lc", target], { cwd: repo, stdio: "pipe", encoding: "utf8" });
      return r.stdout?.toString?.() ?? "";
    }
    const p = isAbsolute(target) ? target : join(repo, target);
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Compute the size of a unified diff (number of added + removed lines). */
export function patchSize(patch: string): number {
  if (!patch || typeof patch !== "string") return 0;
  let adds = 0, dels = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ") || line.startsWith("@@")) continue;
    if (line[0] === "+") adds++;
    else if (line[0] === "-") dels++;
  }
  return adds + dels;
}
