/**
 * TagParser
 * ----------
 * Extracts routed content from model text.
 *
 * Grammar (kept intentionally small and readable):
 * - Agent DM:   "@<agentName> <content until next tag or EOF>"
 * - Group msg:  "@group <content until next tag or EOF>"
 * - File blob:  "#<filename> <content until next tag or EOF>"
 *
 * If the input contains no tags, it is treated as a single group message.
 *
 * Examples:
 *  "@david here are the documents
 *   @robert did you get that thing I sent you? #blob.txt This is an awesome
 *   file I made for you.
 *   @group what are we all thinking?"
 *
 *  =>
 *   [
 *     { kind: "agent", content: "here are the documents", index: 0, tag:"david" },
 *     { kind: "agent", content: "did you get that thing I sent you?", index: 1, tag:"robert" },
 *     { kind: "file",  content: "This is an awesome\nfile I made for you.", index: 2, tag:"blob.txt" },
 *     { kind: "group", content: "what are we all thinking?", index: 3, tag:"group" }
 *   ]
 */

export type ParsedKind = "agent" | "group" | "file";

export interface ParsedTag {
  kind: ParsedKind;
  /** The routing tag: agent name, "group", or filename (for kind:"file"). */
  tag: string;
  /** Content belonging to this tag (trimmed; preserves internal newlines). */
  content: string;
  /** Stable order based on source appearance (0..n-1). */
  index: number;
}

type Token =
  | { kind: "agent" | "group"; tag: string; start: number; contentStart: number }
  | { kind: "file"; tag: string; start: number; contentStart: number };

function isWordBoundary(ch: string | undefined): boolean {
  // treat start-of-string or whitespace as boundaries
  return !ch || /\s/.test(ch);
}

function readWhile(
  s: string,
  start: number,
  test: (c: string) => boolean
): number {
  let i = start;
  while (i < s.length && test(s[i])) i++;
  return i;
}

function scanTokens(s: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    // only consider tags that appear at a word boundary
    if (ch !== "@" && ch !== "#") continue;
    if (!isWordBoundary(s[i - 1])) continue;

    if (ch === "@") {
      // agent name: letters, digits, underscore, dash, dot
      const nameStart = i + 1;
      const nameEnd = readWhile(s, nameStart, (c) => /[A-Za-z0-9_.-]/.test(c));
      if (nameEnd === nameStart) continue; // no name

      const name = s.slice(nameStart, nameEnd);
      const kind = name.toLowerCase() === "group" ? "group" : "agent";
      out.push({
        kind,
        tag: kind === "group" ? "group" : name,
        start: i,
        contentStart: nameEnd + 1 /* skip following space if present */,
      });
      i = nameEnd - 1;
      continue;
    }

    if (ch === "#") {
      // filename: non-whitespace sequence
      const fileStart = i + 1;
      const fileEnd = readWhile(s, fileStart, (c) => !/\s/.test(c));
      if (fileEnd === fileStart) continue; // no filename

      const filename = s.slice(fileStart, fileEnd);
      out.push({
        kind: "file",
        tag: filename,
        start: i,
        contentStart: fileEnd + 1 /* skip following space if present */,
      });
      i = fileEnd - 1;
      continue;
    }
  }
  // Sort by appearance
  out.sort((a, b) => a.start - b.start);
  return out;
}

export class TagParser {
  /**
   * Parse tags from a string into routed segments.
   * If no tags are found, a single group message is returned.
   */
  parse(s: string): ParsedTag[] {
    const text = String(s ?? "");
    const tokens = scanTokens(text);

    if (!tokens.length) {
      const grp = text.trim();
      if (!grp) return [];
      return [{ kind: "group", tag: "group", content: grp, index: 0 }];
    }

    const results: ParsedTag[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const cur = tokens[i];
      const next = tokens[i + 1];
      const end = next ? next.start : text.length;
      const raw = text.slice(cur.contentStart, end);
      const content = raw.trim();

      // Skip empty payloads (rare but possible if tags are back-to-back)
      if (!content) continue;

      results.push({
        kind: cur.kind,
        tag: cur.tag,
        content,
        index: results.length,
      });
    }
    return results;
  }
}
