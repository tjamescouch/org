// src/sandbox/glob.ts
/**
 * RE2-safe glob -> RegExp with these rules:
 *  - *  : any chars within a single segment (no '/'), does NOT match dotfiles unless the segment itself starts with '.'
 *  - ?  : single char within a segment (no '/'), same dot rule as above
 *  - ** : zero or more segments (each segment must not start with '.')
 *  -      requires at least one slash (nested only — does NOT match top-level files)
 *  - trailing '/**' : matches the directory itself OR anything deeper
 *  - Dot-files are only matched when the pattern segment literally starts with '.'
 *
 * No look-ahead/look-behind (compatible with Bun/RE2).
 */

// src/sandbox/glob.ts

// Minimal, safe glob → RegExp converter used by write-policy.
// Supported:
//   - "*"   : any sequence except path separator
//   - "?"   : a single char except path separator
//   - "**"  : spans segments (zero or more directories)
//   - trailing "/**" : match the directory itself OR anything below it
// Dotfiles: not matched by "*" unless the pattern segment starts with "."

function esc(s: string) {
  return s.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
}

function segmentToRe(seg: string): string {
  const allowDot = seg.startsWith(".");
  let out = allowDot ? "" : "(?!\\.)";

  for (let i = 0; i < seg.length; ) {
    const c = seg[i];

    if (c === "*") {
      // collapse consecutive '*'
      let j = i;
      while (j < seg.length && seg[j] === "*") j++;
      const stars = j - i;

      if (stars >= 2) {
        // inside a single segment '**' behaves like '.*' (no slash allowed anyway)
        out += ".*";
      } else {
        out += "[^/]*";
      }
      i = j;
      continue;
    }

    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }

    out += esc(c);
    i++;
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  // Explicit common special-case: "**/*" (requires at least one slash)
  if (glob === "**/*") {
    return new RegExp("^(?:[^/]+/)+[^/]+$");
  }

  // Trailing "/**" -> match the base directory itself OR anything deeper.
  const hasDirTail = glob.endsWith("/**");
  const base = hasDirTail ? glob.slice(0, -3) : glob;

  const parts = base.split("/").filter(p => p.length > 0 || base === ""); // keep "" only if whole glob was ""

  let re = "^";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part === "**") {
      // zero or more full path segments
      re += "(?:[^/]+/)*";
    } else {
      re += segmentToRe(part);
      if (i < parts.length - 1) re += "/";
    }
  }

  if (hasDirTail) {
    // If base is empty, allow anything (/**)
    if (base === "") {
      re += "(?:.*)?$";
      return new RegExp(re);
    }
    // Directory itself OR deeper
    const baseRe = re; // no trailing $
    return new RegExp(`^(?:${baseRe}|${baseRe}/.*)$`);
  }

  re += "$";
  return new RegExp(re);
}

export function matchAny(globs: string[], path: string): boolean {
  for (const g of globs) {
    if (globToRegExp(g).test(path)) return true;
  }
  return false;
}
