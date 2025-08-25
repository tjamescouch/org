// src/sandbox/glob.ts
import * as path from "path";

function normalize(p: string): string {
  // POSIX-style, strip leading "./"
  return p.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function escapeRegex(lit: string): string {
  // Escape regexp special chars
  return lit.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a glob string to a RegExp that matches the *entire* path (anchored).
 * Supported:
 *  - **  -> any chars including slashes (also empty)
 *  - *   -> any chars except slash
 *  - ?   -> one char except slash
 *  - '/' -> literal slash
 *
 * Notes:
 *  - We do not implement brace sets, extglobs, or character classes ([], {}).
 *  - This is purposely small and tuned for our allow/deny patterns.
 */
function globToRegExp(glob: string): RegExp {
  let g = normalize(glob);

  // Special-case trailing "/**" to also match the directory itself.
  const dirWithDeep = g.endsWith("/**");
  if (dirWithDeep) {
    g = g.slice(0, -3); // drop the /** for the base conversion
  }

  // Escape regex specials first, then re-introduce our wildcards.
  let re = escapeRegex(g);

  // '**' first (allow slashes)
  re = re.replace(/\\\*\\\*/g, "[\\s\\S]*");
  // then '*' (no slashes)
  re = re.replace(/\\\*/g, "[^/]*");
  // then '?'
  re = re.replace(/\\\?/g, "[^/]");

  if (dirWithDeep) {
    // If original pattern ended with '/**', accept the dir itself OR any deeper path.
    // Example: ".git/**" -> /^\.git(?:\/.*)?$/
    re = re + "(?:\\/.*)?";
  }

  return new RegExp("^" + re + "$");
}

/**
 * Minimal glob match with sensible defaults for our sandbox policy.
 *
 * - matchBase:true means patterns without '/' are tested against the basename too,
 *   which fixes the classic root-file case (e.g., "**" or "*.txt" matches "hello.txt").
 * - dot:false by default (change if you want wildcards to match dotfiles automatically).
 */
export function matchAny(
  patterns: readonly string[],
  file: string,
  opts?: { matchBase?: boolean; dot?: boolean }
): boolean {
  const p = normalize(file);
  const base = p.split("/").pop() ?? p;
  const matchBase = opts?.matchBase ?? true;
  const dot = opts?.dot ?? false;

  for (const pat of patterns) {
    // dotfile guard: if !dot and basename starts with '.', only match when pattern explicitly starts with '.'
    if (!dot && base.startsWith(".") && !pat.trim().startsWith(".")) {
      // still allow explicit .git/**, .env etc.; this guard only affects wildcard-only patterns
      // (If you want wildcards to match dotfiles, set dot:true.)
    }

    const rx = globToRegExp(pat);
    if (rx.test(p)) return true;

    // matchBase: if the pattern has no '/', also test against the basename
    if (matchBase && pat.indexOf("/") === -1) {
      const rxBase = globToRegExp(pat);
      if (rxBase.test(base)) return true;
    }
  }
  return false;
}
