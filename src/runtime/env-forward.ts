// src/runtime/env-forward.ts
// Helpers for forwarding environment variables to child processes / containers
// in a controlled way.

type SrcEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Collect the subset of environment variables that are safe/expected to forward
 * into interactive shells and containers.
 *
 * By design this forwards any key that starts with one of the allowlisted
 * prefixes (e.g. ORG_, OPENAI_, OLLAMA_, …) as well as a small set of exact
 * keys that commonly affect networking/locale/tooling.
 */
export function collectRuntimeEnv(src: SrcEnv = process.env): Record<string, string> {
  const allowPrefixes = [
    "ORG_",
    "OPENAI_",
    "AZURE_OPENAI_",
    "ANTHROPIC_",
    "OLLAMA_",
    "LMSTUDIO_",
    "GOOGLE_",     // for vertex / genai envs if used
    "GEMINI_",
  ];

  const allowExact = [
    "DEBUG",
    "LOG_LEVEL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "no_proxy",
    "PATH",
    "TERM",
    "TZ",
    "LANG",
    "LC_ALL",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "BUN_CONFIG_VERBOSE_FETCH",
  ];

  const out: Record<string, string> = {};
  for (const [k, vRaw] of Object.entries(src)) {
    if (typeof vRaw !== "string" || vRaw.length === 0) continue;
    const forward =
      allowExact.includes(k) ||
      allowPrefixes.some((p) => k.startsWith(p));
    if (forward) out[k] = vRaw;
  }
  return out;
}

/**
 * Convert an env object into podman `--env KEY=VAL` args.
 */
export function envToPodmanArgs(src: SrcEnv): string[] {
  const env = collectRuntimeEnv(src);
  const args: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    args.push("--env", `${k}=${v}`);
  }
  return args;
}

/**
 * Produce a series of `export KEY='VAL'` statements suitable for injecting into
 * a shell line (e.g. when creating a tmux session).
 */
export function envToShellExports(src: SrcEnv): string {
  const env = collectRuntimeEnv(src);
  if (Object.keys(env).length === 0) return "";
  const parts = Object.entries(env).map(([k, v]) => `export ${shq(k)}=${shq(v)}`);
  return parts.join("; ");
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
