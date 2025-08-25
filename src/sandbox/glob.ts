// src/sandbox/glob.ts
// Tiny glob matcher for allowlists; supports **, *, ? (posix-style).
// Key semantics: "**" matches zero or more characters INCLUDING '/'

// "**" matches across slashes; "*" within a single segment
function escapeRe(s: string) { return s.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&"); }

export function globToRegExp(glob: string): RegExp {
  glob = glob.replace(/^[.][/\\]/, "");           // strip leading "./"
  let re = "^";
  for (let i = 0; i < glob.length; ) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i += 2; }
      else { re += "[^/]*"; i++; }
    } else if (c === "?") { re += "[^/]"; i++; }
    else if (c === "/" || c === "\\") { re += "/"; i++; }
    else { re += escapeRe(c); i++; }
  }
  return new RegExp(re + "$");
}

export function matchAny(globs: string[], p: string): boolean {
  const path = p.replace(/^[.][/\\]/, "").replace(/\\/g, "/");   // normalize
  return globs.some(g => globToRegExp(g).test(path));
}
