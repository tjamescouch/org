// src/utils/spawn-clean.ts
import { spawn, type ChildProcess } from "node:child_process";
// If you already have a builder, keep this import.
// Otherwise pass your own via opts.pathBuilder.
import { buildPATH } from "../config/path";

export type SpawnCleanOpts = {
  shell?: string;                 // default: /bin/bash
  cwd?: string;                   // default: process.cwd()
  env?: NodeJS.ProcessEnv;        // extra env to merge (PATH is overridden)
  timeoutMs?: number;             // optional hard timeout → AbortController.abort()
  stdio?: any;                    // default: ["ignore","pipe","pipe"]
  pathBuilder?: (base: string) => string; // default: buildPATH(basePATH)
  signal?: AbortSignal;           // optional external signal to chain
};

/**
 * Spawn a shell command in a "clean" environment:
 *  - does NOT source rc/profile files (bash --noprofile --norc / zsh -f)
 *  - injects a whitelisted PATH (via env and inline export)
 *  - supports timeout via AbortController
 * Returns the child process plus useful metadata.
 */
export function spawnInCleanEnvironment(
  cmd: string,
  opts: SpawnCleanOpts = {}
): {
  child: ChildProcess;
  abortController: AbortController;
  shell: string;
  args: string[];
  envPATH: string;
    } {
  const shell = opts.shell ?? "/bin/bash";
  const isBash = /(^|\/)bash$/.test(shell);
  const isZsh  = /(^|\/)zsh$/.test(shell);

  const pathBuilder = opts.pathBuilder ?? buildPATH;
  const basePATH = (opts.env?.PATH ?? process.env.PATH) || "";
  const envPATH = pathBuilder(basePATH);

  // Belt & suspenders: export the PATH inline as well
  const runCmd = `export PATH=${JSON.stringify(envPATH)}; set -euo pipefail; ${cmd}`;

  // Avoid rc/profile files so PATH isn’t clobbered
  const args = isBash
    ? ["--noprofile", "--norc", "-c", runCmd]
    : isZsh
    ? ["-f", "-c", runCmd]            // zsh: -f == NO_RCS
    : ["-c", runCmd];                 // dash/sh: -c (login shells read .profile, non-login don't)

  // Clean env: enforce PATH and block non-interactive rc via env vars
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: envPATH,
    ...(opts.env ?? {}),
  };
  delete (env as any).BASH_ENV;  // bash non-interactive rc hook
  delete (env as any).ENV;       // POSIX shells rc hook
  delete (env as any).ZDOTDIR;   // zsh alt rc dir

  // Abort/timeout wiring
  const ac = new AbortController();
  if (opts.signal) {
    // Chain external signal into our controller
    opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  let timer: NodeJS.Timeout | null = null;
  if (opts.timeoutMs && Number.isFinite(opts.timeoutMs)) {
    timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  }

  const child = spawn(shell, args, {
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    cwd: opts.cwd ?? process.cwd(),
    env,
    signal: ac.signal,
  });

  const clear = () => { if (timer) clearTimeout(timer); };
  child.once("close", clear);
  child.once("error", clear);

  return { child, abortController: ac, shell, args, envPATH };
}
