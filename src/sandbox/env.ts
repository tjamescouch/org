// src/sandbox/env.ts
/**
 * Shared helpers for passing host environment into sandboxes/engines.
 *
 * We keep a conservative allow-list: provider creds/URLs, proxies, locale,
 * terminal hints, and anything under ORG_* so callers can opt-in easily.
 */

export type StringMatcher = string | RegExp;

/** Return `-e KEY=VALUE` pairs for Podman/Docker from an env snapshot. */
export function envToPodmanArgs(
  env: NodeJS.ProcessEnv,
  extraAllow?: StringMatcher[],
): string[] {
  const args: string[] = [];
  const allow: StringMatcher[] = [
    // our project namespace
    /^ORG_/,

    // common LLM providers / SDKs
    /^OPENAI_/,
    /^ANTHROPIC_/,
    /^GROQ_/,
    /^GOOGLE_/,
    /^MISTRAL_/,
    /^AZURE_/,
    /^AWS_/,
    /^OLLAMA_/,

    // proxies
    /^HTTP_PROXY$/i,
    /^HTTPS_PROXY$/i,
    /^ALL_PROXY$/i,
    /^NO_PROXY$/i,

    // terminal/locale basics
    /^TERM$/i,
    /^COLORTERM$/i,
    /^LANG$/i,
    /^LC_/,

    // time zone occasionally needed by tools
    /^TZ$/i,

    // misc helpful passthroughs
    /^GIT_/,
    /^SSH_/,
  ];

  if (extraAllow && extraAllow.length) allow.push(...extraAllow);

  const picked = new Set<string>();

  for (const [key, val] of Object.entries(env)) {
    if (val == null) continue;

    // direct name allow
    const direct = allow.some((m) =>
      typeof m === "string" ? m === key : m.test(key)
    );
    if (direct) {
      picked.add(`${key}=${val}`);
    }
  }

  // A few single names we always pass if present (less noise in allow above).
  for (const k of ["LC_ALL", "LC_CTYPE", "LC_MESSAGES"]) {
    const v = env[k];
    if (v != null) picked.add(`${k}=${v}`);
  }

  // Build `-e KEY=VALUE` list in stable order.
  return Array.from(picked)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap((kv) => ["-e", kv]);
}
