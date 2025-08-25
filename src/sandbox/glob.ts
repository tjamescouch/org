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

export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (g === "" || g === ".") return /^$/; // never matches

  // Special: nested only
  if (g === "**/*") {
    // one or more segments (no leading dot), then a file segment (no leading dot)
    return new RegExp("^(?:[^./][^/]*/)+[^./][^/]+$");
  }

  // Trailing "/**" => directory itself OR deeper
  if (g.endsWith("/**")) {
    const base = escapeRe(g.slice(0, -3).replace(/\/+$/, ""));
    // dir itself: ^base$
    // deeper: ^base/(segment)+(/segment)*  (segments cannot start with '.')
    return new RegExp(`^(?:${base})(?:/(?:[^./][^/]*)(?:/(?:[^./][^/]*))*)?$`);
  }

  const parts = g.split("/");
  let re = "^";
  let started = false;
  let prevWasGlobStar = false;

  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];

    if (seg === "**") {
      // zero or more "/segment" groups (segment must not start with '.')
      re += "(?:/(?:[^./][^/]*))*";
      started = true;
      prevWasGlobStar = true;
      continue;
    }

    if (started) {
      // if previous was **, next '/' is optional (to allow zero matches)
      re += prevWasGlobStar ? "(?:/)?" : "/";
    }
    prevWasGlobStar = false;

    re += segmentToRe(seg);
    started = true;
  }

  re += "$";
  return new RegExp(re);
}

function segmentToRe(seg: string): string {
  const allowDot = seg.startsWith(".");
  let out = "";
  let atStart = true;

  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === "*") {
      // at segment start, forbid '.' unless pattern also starts with '.'
      out += (!allowDot && atStart) ? "[^./][^/]*" : "[^/]*";
      atStart = false;
    } else if (ch === "?") {
      out += (!allowDot && atStart) ? "[^./]" : "[^/]";
      atStart = false;
    } else {
      out += escapeRe(ch);
      atStart = false;
    }
  }
  return out || "";
}

function escapeRe(s: string): string {
  return s.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
}

export function matchAny(patterns: readonly string[] | undefined, relPath: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const g of patterns) {
    if (globToRegExp(g).test(p)) return true;
  }
  return false;
}
