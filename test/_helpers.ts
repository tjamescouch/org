// tests/_helpers.ts
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function resolveCli(): string {
  // allow CI/dev override
  const envBin = process.env.ORG_BIN?.trim();
  if (envBin) return envBin;

  // repo-local wrapper (./org) if present
  const local = join(process.cwd(), "org");
  if (existsSync(local)) return `"${local}"`;

  // fallback to Bun entrypoint
  return `bun run src/app.ts`;
}

export function sh(
  cwd: string,
  cmd: string,
  env: Record<string, string> = {}
): { code: number; out: string; err: string } {
  const r = spawnSync("bash", ["-lc", cmd], {
    cwd: cwd || process.cwd(),
    stdio: "pipe",
    env: { ...process.env, ...env },
  });
  return {
    code: r.status ?? 0,
    out: r.stdout?.toString("utf8") ?? "",
    err: r.stderr?.toString("utf8") ?? "",
  };
}

export function shMust(cwd: string, cmd: string, env: Record<string, string> = {}) {
  const { code, out, err } = sh(cwd, cmd, env);
  if (code !== 0) throw new Error(`Command failed (${code}): ${cmd}\n${err || out}`);
  return out;
}

export function initRepo(): string {
  const wd = mkdtempSync(join(tmpdir(), "org-e2e-"));
  shMust(wd, "git init -q");
  shMust(wd, "git config user.email noreply@example.com");
  shMust(wd, "git config user.name org");
  writeFileSync(join(wd, ".gitignore"), "\n");
  shMust(wd, "git add -A && git commit -m init -q");
  return wd;
}

export function lastRunDir(repo: string): string | null {
  const { out } = sh(repo, "ls -td .org/runs/* 2>/dev/null | head -n1");
  const s = out.trim();
  return s.length ? s : null;
}

export function readFileSafe(repo: string, rel: string): string {
  try {
    return execSync(`cat "${rel}"`, { cwd: repo, stdio: "pipe" }).toString("utf8");
  } catch {
    return "";
  }
}

export function patchSize(repo: string, runDir: string): number {
  const p = join(runDir, "session.patch");
  try { return statSync(p).size; } catch { return 0; }
}

/**
 * Spawn org against a repo.
 * - Forces LLM_DRIVER=mock so we never hit a real model in CI/tests.
 * - Defaults SANDBOX_BACKEND=none and ORG_REVIEW=auto for headless runs.
 * - Returns code/out/err; caller should assert code===0 and print err if not.
 */
export function runOrg(
  repo: string,
  prompt: string,
  extraEnv: Record<string, string> = {}
) {
  const CLI = resolveCli();
  const env = {
    LLM_DRIVER: "mock",     // <-- make the agent deterministic & offline
    SANDBOX_BACKEND: "none",
    ORG_REVIEW: "auto",
    ...extraEnv,
  };

  const cmd = `${CLI} -C "${repo}" --agents "alice:mock" --max-tools 10 --prompt '${prompt}'`;

  const r = spawnSync("bash", ["-lc", cmd], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, ...env },
  });

  return {
    code: r.status ?? 0,
    out: r.stdout?.toString("utf8") ?? "",
    err: r.stderr?.toString("utf8") ?? "",
  };
}
