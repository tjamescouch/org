// src/sandbox/glob.ts
// Tiny glob matcher for allowlists; supports **, *, ? (posix style)

export function globToRegExp(glob: string): RegExp {
  // Normalize leading "./"
  glob = glob.replace(/^[.][/\\]/, "");
  const special = /[\\^$+.|()[\]{}]/g;
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** (match across path separators)
        i += 2;
        // optional following slash
        if (glob[i] === "/" || glob[i] === "\\") i++;
        re += "(.+?/)*";
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "/") {
      re += "/";
      i++;
    } else {
      re += c.replace(special, "\\$&");
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function matchAny(globs: string[], pathUnderWork: string): boolean {
  const p = pathUnderWork.replace(/^[.][/\\]/, "");
  return globs.some((g) => globToRegExp(g).test(p));
}
