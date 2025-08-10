import { spawn } from "bun";

async function sh(cmd: string, args: string[], cwd?: string) {
  const proc = spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

export async function gitStatus(cwd = ".") {
  return sh("git", ["status", "--porcelain"], cwd);
}
export async function gitAddAll(cwd = ".") {
  return sh("git", ["add", "-A"], cwd);
}
export async function gitCommit(msg: string, cwd = ".") {
  return sh("git", ["commit", "-m", msg], cwd);
}
export async function gitRevert(commit: string, cwd = ".") {
  return sh("git", ["revert", "--no-edit", commit], cwd);
}
export async function gitBranch(name: string, cwd = ".") {
  return sh("git", ["checkout", "-B", name], cwd);
}