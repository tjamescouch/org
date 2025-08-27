// test/helpers/run-org-with-keys.ts
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type RunResult = { code: number | null; out: string; err: string };

type Options = {
  cwd: string;
  agents?: string;         // default: "alice:mock"
  env?: Record<string, string>;
  reviewMode?: "ask" | "auto" | "never"; // default: ask (non-TTY => auto apply in app)
  timeoutMs?: number;      // default: 20_000
};

function isExe(p: string | undefined): p is string {
  try {
    if (!p) return false;
    const st = fs.statSync(p);
    // regular file is good enough for CI; exec bit not always preserved on Windows
    return st.isFile() || st.isSymbolicLink();
  } catch { return false; }
}

/** Resolve an absolute path to the org binary. */
function resolveOrgBin(): string {
  // 1) Explicit override via env
  if (isExe(process.env.ORG_BIN)) return path.resolve(process.env.ORG_BIN as string);

  // 2) From repo root: this file lives at <root>/test/helpers/run-org-with-keys.ts
  const repoRoot = path.resolve(__dirname, "../../");
  const candidates = [
    path.join(repoRoot, "org"),          // repo script (most setups)
    path.join(repoRoot, "bin", "org"),   // alt layout
  ];
  for (const c of candidates) {
    if (isExe(c)) return c;
  }

  // 3) Fallback to PATH (only if developer already exported it)
  return "org";
}

/**
 * Spawn the real CLI and feed keystrokes.
 * - Forces SANDBOX_BACKEND=none (no Podman)
 * - Passes a fixed --prompt "<seed>" to make the run non-interactive
 * - Returns stdout/stderr and exit code
 *
 * @param seedPrompt text passed to --prompt "<seed>"
 * @param keys keys written to stdin (\x1b = ESC, etc.)
 */
export async function runOrgWithKeys(
  seedPrompt: string,
  keys: Array<string | Buffer>,
  opts: Options
): Promise<RunResult> {
  const {
    cwd,
    agents = "alice:mock",
    reviewMode = "ask",
    timeoutMs = 20_000,
    env = {},
  } = opts;

  const bin = resolveOrgBin();

  const child = spawn(
    bin,
    [
      "--agents", agents,
      "--max-tools", "10",
      "--review", reviewMode,
      "--prompt", seedPrompt,
    ],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...env,
        SANDBOX_BACKEND: env.SANDBOX_BACKEND ?? "none",
        ORG_RECIPE: env.ORG_RECIPE ?? "",
        NO_COLOR: "1",
      },
    }
  );

  let out = "";
  let err = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { err += String(d); });

  // give the CLI a moment to print headers so our key lands deterministically
  setTimeout(() => {
    for (const k of keys) child.stdin.write(k);
  }, 200);

  const killer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, timeoutMs);

  const code: number | null = await new Promise((resolve) => {
    child.on("close", (c) => resolve(c));
  });

  clearTimeout(killer);

  return { code, out, err };
}
