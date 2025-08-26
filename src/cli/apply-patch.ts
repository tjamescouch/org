// src/cli/apply-patch.ts
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs/promises";

type R = { code: number; stdout: string; stderr: string };
const run = (cmd: string, args: string[], cwd: string): Promise<R> =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let so = "", se = "";
    p.stdout.on("data", d => (so += String(d)));
    p.stderr.on("data", d => (se += String(d)));
    p.on("close", code => resolve({ code: code ?? -1, stdout: so, stderr: se }));
  });

const ok = async (r: Promise<R>, msg: string) => {
  const x = await r;
  if (x.code !== 0) throw new Error(`${msg}: ${x.stderr || x.stdout}`);
  return x;
};

export async function applySessionPatch(repoDir: string, patchPath: string, commitMsg: string) {
  const abs = path.resolve(patchPath);
  try { await fs.stat(abs); } catch { throw new Error(`patch not found: ${abs}`); }
  await ok(run("git", ["rev-parse", "--is-inside-work-tree"], repoDir), "not a git repository");

  // Be explicit about line endings & whitespace noise.
  const applyArgs = ["apply", "--whitespace=nowarn"];

  // Fast path: index-aware, 3-way.
  let r = await run("git", [...applyArgs, "--index", "--3way", abs], repoDir);
  if (r.code === 0) {
    await ok(run("git", ["commit", "-m", commitMsg || "Apply org session patch"], repoDir), "git commit");
    return;
  }

  // Fallback: apply to worktree (no index), then stage everything that applied.
  const r2 = await run("git", [...applyArgs, "--reject", abs], repoDir);
  if (r2.code !== 0) {
    throw new Error(`git apply failed:\n${r.stderr || r.stdout || r2.stderr || r2.stdout}`);
  }

  // If there are .rej files, surface a clean error.
  const rej = await run("bash", ["-lc", "git ls-files -o --exclude-standard | grep -c '\\.rej$' || true"], repoDir);
  const rejCount = parseInt((rej.stdout || "0").trim() || "0", 10);
  if (rejCount > 0) {
    throw new Error(`patch had conflicts; ${rejCount} *.rej files written`);
  }

  await ok(run("git", ["add", "-A"], repoDir), "git add -A");
  await ok(run("git", ["commit", "-m", commitMsg || "Apply org session patch"], repoDir), "git commit");
}
