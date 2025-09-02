// A tiny helper to forward selected env vars into the shell that tmux launches.
// We do this by inlining `export VAR=...` *before* the app command.
// Works on all tmux versions because it's just a shell export.

const DEFAULT_PREFIXES = [
  // model backends and our own config
  "OPENAI_", "ORG_", "ANTHROPIC_", "LMSTUDIO_", "OLLAMA_", "AZURE_",
  // common networking/proxy knobs
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  // coloring & debug knobs that affect CLI behaviour
  "FORCE_COLOR", "NO_COLOR", "DEBUG",
  // shell basics
  "PATH", "HOME", "SHELL", "USER", "LANG", "LC_ALL", "LC_CTYPE",
];

export function buildExportPrefix(
  env: Record<string, string | undefined> = process.env,
  extraAllow: string[] = []
): string {
  const allow = new Set([...DEFAULT_PREFIXES, ...extraAllow]);
  const pairs: string[] = [];

  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if ([...allow].some(prefix => k.startsWith(prefix))) {
      // crude shell escaping; good enough for typical URLs/tokens
      const val = v.replaceAll("'", "'\"'\"'");
      pairs.push(`${k}='${val}'`);
    }
  }

  // TERM matters for readline/TTY behaviour inside tmux
  if (!pairs.some(p => p.startsWith("TERM="))) {
    pairs.push("TERM='xterm-256color'");
  }

  return pairs.length ? `export ${pairs.join(" ")}; ` : "";
}
