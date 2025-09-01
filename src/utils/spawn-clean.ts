// utils/spawn-clean.ts
import { spawn, type ChildProcess } from "node:child_process";

type SpawnWithTimeoutOpts = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;   // hard timeout (default: undefined = no timeout)
  graceMs?: number;     // after abort/SIGTERM, wait then SIGKILL (default: 5000)
  /** Optional: build/whitelist PATH before passing to child. If omitted, reuse base PATH. */
  pathBuilder?: (basePATH: string) => string;
  /** Optional: override stdio. Default: ["ignore","pipe","pipe"] */
  stdio?: any;
  shell?: boolean;
  /** Optional label used for debug output on timeout. */
  debugLabel?: string;
};

/**
 * Spawn a shell in a "clean" environment:
 *  - does NOT source rc/profile files (bash --noprofile --norc, zsh -f)
 *  - injects a caller-controlled PATH (via env + inline `export PATH=…`)
 *  - supports timeout via AbortController with SIGKILL escalation
 *
 * Signature intentionally matches the legacy `spawnWithTimeout(shell, args, opts)` so
 * you can drop it in as a replacement.
 */
export function spawnInCleanEnvironment(
  shell: string,
  args: string[],
  opts: SpawnWithTimeoutOpts = {}
): ChildProcess {
  const isBash = /(^|\/)bash$/.test(shell);
  const isZsh  = /(^|\/)zsh$/.test(shell);

  // Build PATH to pass to the child
  const basePATH = (opts.env?.PATH ?? process.env.PATH) || "";
  const envPATH = opts.pathBuilder ? opts.pathBuilder(basePATH) : basePATH;

  // We’ll try to wrap the command used with -c to also export PATH inline,
  // so even if the shell mutates PATH internally the command still sees what we want.
  const wrapCmd = (cmd: string) =>
    `export PATH=${JSON.stringify(envPATH)}; set -euo pipefail; ${cmd}`;

  // Normalize args to avoid login/rc files and to wrap the -c command if present.
  const normalizeArgs = (inArgs: string[]): string[] => {
    const out: string[] = [];

    // bash: add --noprofile --norc; zsh: add -f (NO_RCS)
    if (isBash) out.push("--noprofile", "--norc");
    if (isZsh)  out.push("-f");

    for (let i = 0; i < inArgs.length; i++) {
      const a = inArgs[i];

      // collapse "-lc" (login+command) → "-c" and drop login behavior
      if (a === "-lc") {
        out.push("-c");
        const cmd = inArgs[i + 1] ?? "";
        out.push(wrapCmd(cmd));
        i++; // consumed the command string
        continue;
      }

      // drop explicit login flags if present
      if (a === "-l" || a === "--login") {
        continue; // skip
      }

      // regular "-c <cmd>" — wrap the command to export PATH
      if (a === "-c") {
        out.push("-c");
        const cmd = inArgs[i + 1] ?? "";
        out.push(wrapCmd(cmd));
        i++; // consumed the command string
        continue;
      }

      // anything else is passed through
      out.push(a);
    }

    return out;
  };

  const finalArgs = normalizeArgs(args);

  // Build the child env (force PATH, remove rc hooks)
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: envPATH,
    ...(opts.env ?? {}),
  };
  delete (childEnv as any).BASH_ENV; // bash non-interactive hook
  delete (childEnv as any).ENV;      // sh/ksh/zsh rc hook
  delete (childEnv as any).ZDOTDIR;  // zsh alt rc dir

  // Timeout wiring
  const ac = new AbortController();
  const graceMs = opts.graceMs ?? 5000;
  let killer: NodeJS.Timeout | null = null;
  let timer: NodeJS.Timeout | null = null;

  if (opts.timeoutMs && Number.isFinite(opts.timeoutMs)) {
    timer = setTimeout(() => {
      // Abort sends SIGTERM in Node's spawn with signal
      try { ac.abort(); } catch {}
      // Optional stderr note (comment out if you want it silent)
      try {
        process.stderr.write(
          `\n[spawn] timeout after ${opts.timeoutMs}ms${opts.debugLabel ? ` (${opts.debugLabel})` : ""} → SIGTERM`
        );
      } catch {}
      // Escalate to SIGKILL after grace period if still running
      killer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, Math.max(0, graceMs));
    }, opts.timeoutMs);
  }

  const child = spawn(shell, finalArgs, {
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    shell: opts.shell,
    cwd: opts.cwd ?? process.cwd(),
    env: childEnv,
    signal: ac.signal,
  });

  const clearTimers = () => {
    if (timer)  clearTimeout(timer);
    if (killer) clearTimeout(killer);
  };
  child.once("close", clearTimers);
  child.once("error", clearTimers);

  return child;
}
