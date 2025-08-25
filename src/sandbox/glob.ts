// src/sandbox/glob.ts
// Tiny glob matcher for allowlists; supports **, *, ? (posix-style).
// Key semantics: "**" matches zero or more characters INCLUDING '/'

function escapeRe(s: string): string {
  return s.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
}

export function globToRegExp(glob: string): RegExp {
  // Normalize leading "./"
  glob = glob.replace(/^[.][/\\]/, "");
  let re = "^";
  for (let i = 0; i < glob.length; ) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**" → match anything (including '/'), zero or more chars
        re += ".*";
        i += 2;
      } else {
        // "*" → match within a single path segment (no '/')
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "/" || c === "\\") {
      re += "/";
      i++;
    } else {
      re += escapeRe(c);
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function matchAny(globs: string[], pathUnderWork: string): boolean {
  // Always normalize to forward slashes and strip any leading "./"
  const p = pathUnderWork.replace(/^[.][/\\]/, "").replace(/\\/g, "/");
  return globs.some((g) => globToRegExp(g).test(p));
}
