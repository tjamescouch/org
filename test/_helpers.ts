// tests/_helpers.ts
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function sh(cwd: string, cmd: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const r = spawnSync("bash", ["-lc", cmd], { cwd, stdio: "pipe", env: { ...process.env, ...env } });
  return { code: r.status ?? 0, out: r.stdout?.toString("utf8") ?? "", err: r.stderr?.toString("utf8") ?? "" };
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
  if (!existsSync(p)) return 0;
  return statSync(p).size;
}

export function runOrg(repo: string, prompt: string, extraEnv: Record<string, string> = {}) {
  // Headless, no sandbox to keep CI fast by default
  const env = {
    SANDBOX_BACKEND: "none",
    ORG_REVIEW: "auto",
    ...extraEnv,
  };
  return sh("", `org -C "${repo}" --agents "alice:lmstudio" --max-tools 10 --prompt '${prompt}'`, env);
}
