import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";

type Run = { code: number; stdout: string; stderr: string };

function run(cmd: string, args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let so = "", se = "";
    p.stdout.on("data", d => (so += String(d)));
    p.stderr.on("data", d => (se += String(d)));
    p.on("close", code => resolve({ code: code ?? -1, stdout: so, stderr: se }));
  });
}
const git = (cwd: string, ...args: string[]) => run("git", args, cwd);

async function ensureRepoWithHead(projectDir: string): Promise<void> {
  // Detect repo; init if needed
  if ((await git(projectDir, "rev-parse", "--git-dir")).code !== 0) {
    const init = await git(projectDir, "init");
    if (init.code !== 0) throw new Error(`git init failed: ${init.stderr || init.stdout}`);
  }
  // Ensure a HEAD exists to branch from
  const headOk = await git(projectDir, "rev-parse", "--verify", "-q", "HEAD");
  if (headOk.code !== 0) {
    // Make a baseline (empty if nothing staged)
    await git(projectDir, "add", "-A");
    const diff = await git(projectDir, "diff", "--cached", "--quiet");
    if (diff.code === 0) {
      await git(projectDir, "commit", "--allow-empty", "-m", "org: baseline");
    } else {
      await git(projectDir, "commit", "-m", "org: baseline");
    }
  }
}

function tsTag() {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${pad(t.getMonth()+1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
}

async function removeRejFiles(root: string) {
  // Remove '*.rej' outside .git/.org (rejects from failed apply)
  async function walk(dir: string) {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of ents) {
      if (e.name === ".git" || e.name === ".org") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && p.endsWith(".rej")) { try { await fsp.rm(p); } catch {} }
    }
  }
  await walk(root);
}

export type ApplyResult = {
  ok: boolean;
  error?: string;
  backupRef?: string;
  stashRef?: string;
};

/**
 * Transactional patch apply with rollback.
 *
 * Steps:
 *  1) Ensure repo + HEAD
 *  2) Create backup branch (org.bak.<ts>) at current HEAD
 *  3) Stash dirty/untracked working tree (record stash ref)
 *  4) Apply patch to a clean tree; commit if staged
 *  5) If success: pop stash back (best effort), delete backup (best effort)
 *  6) If failure: reset --hard to backup, pop stash back, delete *.rej
 */
export async function applyPatchWithRollback(args: {
  projectDir: string;
  patchPath: string;
  runId?: string;
}): Promise<ApplyResult> {
  const { projectDir, patchPath } = args;
  await ensureRepoWithHead(projectDir);

  const bakRef = `org.bak.${tsTag()}`;
  const branch = await git(projectDir, "branch", "--quiet", bakRef, "HEAD");
  if (branch.code !== 0) {
    return { ok: false, error: `failed to create backup ref: ${branch.stderr || branch.stdout}` };
  }

  // Stash everything (incl. untracked) so we apply onto a clean index/tree
  const stashPush = await git(projectDir, "stash", "push", "--include-untracked", "-m", bakRef);
  // Extract created stash ref (if any)
  let stashRef: string | undefined;
  {
    const list = await git(projectDir, "stash", "list");
    const line = (list.stdout || "").split("\n").find(l => l.includes(bakRef));
    if (line) stashRef = line.split(":")[0]?.trim(); // e.g. "stash@{0}"
  }

  // Apply
  let applied = await git(projectDir,
    "apply",
    "--index",
    "--reject",
    "--allow-binary-replacement",
    "--whitespace=nowarn",
    patchPath
  );

  // If `git apply` returned 0 but nothing staged (edge case), we still commit if needed.
  if (applied.code === 0) {
    const quiet = await git(projectDir, "diff", "--cached", "--quiet");
    if (quiet.code !== 0) {
      const c = await git(projectDir, "commit", "-m", "org: apply session patch");
      if (c.code !== 0) {
        applied = c; // treat as failure below
      }
    }
  }

  const success = applied.code === 0;

  if (success) {
    // Try to restore user’s local changes on top
    if (stashRef) {
      await git(projectDir, "stash", "pop", "--index", stashRef);
    }
    // Try to delete backup branch (best effort)
    await git(projectDir, "branch", "-D", bakRef);
    return { ok: true, backupRef: bakRef };
  }

  // -------- ROLLBACK --------
  await git(projectDir, "reset", "--hard", bakRef);
  if (stashRef) {
    await git(projectDir, "stash", "pop", "--index", stashRef);
  }
  await removeRejFiles(projectDir);
  // Best-effort cleanup of backup branch even on failure; we’ve reset to it already.
  await git(projectDir, "branch", "-D", bakRef);

  return { ok: false, error: applied.stderr || applied.stdout || "git apply failed", backupRef: bakRef, stashRef };
}
