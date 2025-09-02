// src/utils/pass-env.ts
//
// Utilities to (a) collect the development env we want to propagate,
// (b) apply it to tmux sessions, and (c) turn it into podman args.

export type EnvMap = Record<string, string>;

const EXACT_ALLOW = new Set([
  // terminal / locale
  "TERM", "COLORTERM", "FORCE_COLOR",
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  // proxies are frequently needed inside the container
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "NO_PROXY", "no_proxy",
]);

const PREFIX_ALLOW = [
  // our project knobs first
  "ORG_",            // ORG_OPENAI_*, ORG_LLM_*, ORG_*
  // providers
  "OPENAI_", "ANTHROPIC_", "AZURE_OPENAI_", "GOOGLE_",
  "LMSTUDIO_", "OLLAMA_",
];

/** Collect a safe pass‑through env from the current process (or a stub). */
export function collectRuntimeEnv(src: NodeJS.ProcessEnv = process.env): EnvMap {
  const out: EnvMap = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v !== "string") continue;
    if (EXACT_ALLOW.has(k)) { out[k] = v; continue; }
    if (PREFIX_ALLOW.some(p => k.startsWith(p))) { out[k] = v; continue; }
  }
  return out;
}

/** Convenience: merge overrides on top of collected env. Later keys win. */
export function mergeEnv(base: EnvMap, extra: EnvMap): EnvMap {
  return Object.assign({}, base, extra);
}

/** Apply env to a tmux session (server‑side), so panes inherit it. */
export async function applyEnvToTmux(session: string, env: EnvMap): Promise<void> {
  for (const [k, v] of Object.entries(env)) {
    // tmux set-environment -t <session> KEY VALUE
    const p = Bun.spawn(["tmux", "set-environment", "-t", session, k, v]);
    const code = await p.exited;
    if (code !== 0) {
      const err = await new Response(p.stderr!).text();
      throw new Error(`tmux set-environment failed for ${k} (${code})\n${err}`);
    }
  }
}

/** Turn an env map into podman `-e KEY=VAL` arguments. */
export function envToPodmanArgs(env: EnvMap): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    args.push("-e", `${k}=${v}`);
  }
  return args;
}
