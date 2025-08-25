// src/sandbox/glob.ts
//
// Minimal glob -> RegExp with the following behavior:
//   - "*"   any run of non-slash chars (includes dotfiles)
//   - "?"   any single non-slash char
//   - "**"  globstar
//   - "**/*"        : requires at least one "/" (nested only)
//   - "**/<seg>"    : requires at least one "/" before <seg> (nested only)
//   - trailing "/**": matches the directory itself OR anything deeper
// Policy helper: deny overrides allow.

export function matchAny(patterns: string[] | undefined, p: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  const norm = normalizePath(p);
  for (const pat of patterns) {
    if (globToRegExp(pat).test(norm)) return true;
  }
  return false;
}

export function globToRegExp(glob: string): RegExp {
  const g = normalizePath(glob);
  const parts = g.split("/");

  let re = "^";
  let suppressNextSlash = false;

  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const isLast = i === parts.length - 1;

    if (seg === "**") {
      if (isLast) {
        // trailing "/**" -> allow the dir itself OR anything deeper
        re += "(?:/.*)?";
        continue;
      } else {
        // "**/" before another segment:
        // require at least one path segment before the next segment
        // (nested-only semantics)
        re += "(?:[^/]+/)+";
        suppressNextSlash = true; // we already emitted the slash
        continue;
      }
    }

    // add path separator between segments unless we just emitted it
    if (i > 0 && !suppressNextSlash) re += "/";
    suppressNextSlash = false;

    re += segmentToRe(seg);
  }

  re += "$";
  return new RegExp(re);
}

function segmentToRe(seg: string): string {
  // "*" should match dotfiles too, so we use [^/]* (no ^\\.)
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if ("+|()[]{}^$\\.".includes(ch)) out += "\\" + ch;
    else out += ch;
  }
  return out;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isAllowed(
  file: string,
  allow: readonly string[] | undefined,
  deny: readonly string[] | undefined
): boolean {
  const f = normalizePath(file);
  if (deny && matchAny(deny as string[], f)) return false; // deny wins
  if (!allow || allow.length === 0) return false;
  return matchAny(allow as string[], f);
}