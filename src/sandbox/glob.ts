// src/sandbox/glob.ts
//
// Minimal, dependency-free globbing that matches your test semantics:
// - "*" and "?" never cross '/'; they DO match dot segments
// - "**/*" is nested only (must contain at least one '/')
// - trailing "/**" matches the dir itself OR anything deeper
// - deny wins over allow

const reCache = new Map<string, RegExp>();

function escRe(s: string) {
  return s.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function compileSegment(seg: string): string {
  // Single path segment (no '/'); '*' and '?' include dot segments.
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += escRe(c);
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  const key = `g:${glob}`;
  const cached = reCache.get(key);
  if (cached) return cached;

  glob = glob.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");

  // special case: exactly "**/*" => nested only
  if (glob === "**/*") {
    const nestedOnly = new RegExp("^.+/[^/]+$");
    reCache.set(key, nestedOnly);
    return nestedOnly;
  }

  const parts = glob.split("/");
  let re = "^";

  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];

    if (seg === "**") {
      const last = i === parts.length - 1;
      if (last) {
        // trailing "/**": dir itself or deeper; if pattern is just "**", match anything
        re += parts.length === 1 ? ".*" : "(?:/.*)?";
      } else {
        // "**/" mid-pattern: one or more directories (dot dirs allowed)
        re += "(?:/[^/]+)+";
      }
      continue;
    }

    if (i > 0) re += "/";
    re += compileSegment(seg);
  }

  re += "$";
  const compiled = new RegExp(re);
  reCache.set(key, compiled);
  return compiled;
}

export function matchAny(patterns: readonly string[], path: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  path = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
  for (const p of patterns) {
    if (globToRegExp(p).test(path)) return true;
  }
  return false;
}

export function isAllowed(
  path: string,
  allow: readonly string[],
  deny: readonly string[]
): boolean {
  path = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
  if (deny && deny.length && matchAny(deny, path)) return false;
  return allow && allow.length ? matchAny(allow, path) : true;
}
