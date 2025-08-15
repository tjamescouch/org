/**
 * Flattens chain-of-thought blocks that come in as one-token-per-line.
 * Keeps it conservative: collapse newlines/tabs to spaces and squeeze runs.
 */
export function flattenThink(s: string): string {
  if (!s) return s;
  return s.replace(/[ \t]*\n[ \t]*/g, " ").replace(/\s+/g, " ").trim();
}
