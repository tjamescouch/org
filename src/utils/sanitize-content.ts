function normalizeContent(raw: string) {
  let cmd = raw.trim();
  // strip redundant leading "bash -lc ..."
  cmd = cmd.replace(/^\s*(?:bash|sh)\s+-lc\s+/, "");
  // collapse accidental outer quotes
  if ((cmd.startsWith('"') && cmd.endsWith('"')) ||
      (cmd.startsWith("'") && cmd.endsWith("'"))) {
    cmd = cmd.slice(1, -1);
  }
  if (!cmd) throw new Error("Command required.");
  return cmd;
}

/**
 * Decode common backslash escapes in model text—even when mixed with real newlines.
 * Handles \n, \r, \t, \b, \f, \v, \\, \", \', \/, \xHH, and \uXXXX (incl. surrogate pairs).
 * Pairs of backslashes collapse correctly so "\\n" stays "\n" literally,
 * while "\n" becomes an actual newline. Unknown escapes are preserved.
 */
export function sanitizeContent(text: string): string {
  const s = String(text ?? "");
  if (s.indexOf("\\") === -1) return s; // fast path

  const out: string[] = [];
  const len = s.length;
  let i = 0;

  while (i < len) {
    const ch = s.charCodeAt(i);
    if (ch !== 92 /* '\' */) {
      out.push(String.fromCharCode(ch));
      i++;
      continue;
    }

    // Count consecutive backslashes
    let j = i;
    while (j < len && s.charCodeAt(j) === 92) j++;
    const count = j - i;

    // Emit one literal '\' per full pair
    const pairs = (count / 2) | 0;
    if (pairs) out.push("\\".repeat(pairs));

    if ((count & 1) === 0) {
      // Even number: no escape applies; continue from next char
      i = j;
      continue;
    }

    // Odd number: next char is escaped (if present)
    if (j >= len) {
      out.push("\\"); // trailing backslash at end
      i = j;
      break;
    }

    const e = s.charAt(j);
    switch (e) {
      case "n": out.push("\n"); i = j + 1; break;
      case "r": out.push("\r"); i = j + 1; break;
      case "t": out.push("\t"); i = j + 1; break;
      case "b": out.push("\b"); i = j + 1; break;
      case "f": out.push("\f"); i = j + 1; break;
      case "v": out.push("\v"); i = j + 1; break;
      case "\\": out.push("\\"); i = j + 1; break;
      case "\"": out.push('"'); i = j + 1; break;
      case "'": out.push("'"); i = j + 1; break;
      case "/": out.push("/"); i = j + 1; break;

      case "x": { // \xHH
        const hex = s.slice(j + 1, j + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out.push(String.fromCharCode(parseInt(hex, 16)));
          i = j + 3;
        } else {
          out.push("\\x"); // preserve unknown/partial
          i = j + 1;
        }
        break;
      }

      case "u": { // \uXXXX (and surrogate pair)
        const hex4 = s.slice(j + 1, j + 5);
        if (/^[0-9A-Fa-f]{4}$/.test(hex4)) {
          const hi = parseInt(hex4, 16);

          // Try surrogate pair \uD8xx\uDCxx
          const hasPair =
            j + 5 < len - 1 &&
            s.charAt(j + 5) === "\\" &&
            s.charAt(j + 6) === "u" &&
            /^[0-9A-Fa-f]{4}$/.test(s.slice(j + 7, j + 11));

          if (hi >= 0xd800 && hi <= 0xdbff && hasPair) {
            const lo = parseInt(s.slice(j + 7, j + 11), 16);
            const cp = (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
            out.push(String.fromCodePoint(cp));
            i = j + 11;
          } else {
            out.push(String.fromCharCode(hi));
            i = j + 5;
          }
        } else {
          out.push("\\u"); // preserve unknown/partial
          i = j + 1;
        }
        break;
      }

      default:
        // Unknown escape -> preserve as-is
        out.push("\\", e);
        i = j + 1;
        break;
    }
  }

  return out.join("");
}
