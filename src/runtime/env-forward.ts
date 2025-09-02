// Centralized allowlist-based environment forwarding for interactive shells (tmux)
// and container backends (podman/docker). Keep this list small and explicit.

export type EnvMap = Record<string, string>;

const EXACT: string[] = [
  // generic
  "NO_COLOR", "FORCE_COLOR", "TERM",

  // openai-compatible clients
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "ORG_OPENAI_API_KEY", "ORG_OPENAI_BASE_URL",

  // lmstudio (if you still support a dedicated provider)
  "LMSTUDIO_API_KEY", "ORG_LMSTUDIO_API_KEY", "LMSTUDIO_BASE_URL", "ORG_LMSTUDIO_BASE_URL",

  // app flags
  "ORG_ENGINE", "ORG_SANDBOX_BACKEND", "ORG_UI", "ORG_REVIEW_MODE",

  // any repo-specific toggles you rely on during tests/dev
  "ORG_DEBUG", "ORG_LOG_LEVEL",
];

const PREFIXES: string[] = [
  // keep ORG_* to allow future feature flags
  "ORG_",
];

export function collectForwardEnv(src: NodeJS.ProcessEnv): EnvMap {
  const out: EnvMap = {};
  for (const key of EXACT) {
    const v = src[key];
    if (typeof v === "string" && v.length) out[key] = v;
  }
  for (const k of Object.keys(src)) {
    if (PREFIXES.some(p => k.startsWith(p)) && !(k in out)) {
      const v = src[k];
      if (typeof v === "string" && v.length) out[k] = v;
    }
  }
  return out;
}

/** Convert to ["-e","KEY=VAL", ...] for tmux new-session */
export function toTmuxEnvArgs(env: EnvMap): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  return args;
}

/** Convert to ["-e","KEY=VAL", ...] for podman/docker */
export function toContainerEnvArgs(env: EnvMap): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  return args;
}
