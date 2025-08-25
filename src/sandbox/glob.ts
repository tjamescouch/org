// Tiny glob -> RegExp with sane '**' and '*' semantics (no micromatch).
// - '*'   matches within a single path segment (no '/')
// - '**'  matches across segments (may include '/')
// - '? '  matches a single non-'/' char
// - trailing '/**' means "the directory itself OR anything below it"
// - we do not support character classes or extglobs.
//
// All paths must be POSIX-style (use '/' as separator). Callers should pass
// relative repo paths like "foo.txt", "src/x/y.ts", not absolute paths.

export function normalizePath(p: string): string {
  // collapse backslashes and duplicate slashes
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\/+/, "");
}

function escapeRegexExceptStars(s: string): string {
  // escape all regex metas EXCEPT * and ?; we'll rewrite those next
  return s.replace(/([.+^${}()|[\]\\])/g, "\\$1");
}

export function globToRegExp(glob: string): RegExp {
  let g = normalizePath(glob);

  // Special-case: pure "**" should match everything (including empty)
  if (g === "**") return /^.*$/;

  // Build a regex string in a few safe passes:
  //  1) escape regex chars except * and ?
  //  2) translate well-known glob constructs in the right order
  let re = escapeRegexExceptStars(g);

  // Trailing "/**"  ->  "(?:/.*)?"
  // Accept the directory itself OR anything deeper.
  re = re.replace(/\/\*\*$/g, "(?:\\/.*)?");

  // "**/" anywhere (0+ directories plus a slash)
  // Use a non-greedy-ish construction so following literals still match.
  re = re.replace(/(?:^|\/)\*\*\//g, "(?:.*\\/)?");

  // Remaining "**" (not followed by '/'): cross-segment matches
  re = re.replace(/\*\*/g, ".*");

  // Now single-segment wildcards
  re = re.replace(/\*/g, "[^/]*");
  re = re.replace(/\?/g, "[^/]");

  return new RegExp("^" + re + "$");
}

export function matchAny(patterns: readonly string[], candidate: string): boolean {
  const path = normalizePath(candidate);
  for (const pat of patterns) {
    const rx = globToRegExp(pat);
    if (rx.test(path)) return true;
  }
  return false;
}
