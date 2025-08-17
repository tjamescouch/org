/**
 * TagParser
 * Split text into parts addressed to @@agent, @@group, @@user or ##file sections.
 *
 * Filenames can include slashes. If a filename does not start with "/" or ".",
 * it will be normalized by prefixing "./" (relative path).
 *
 * Examples:
 * parse(`@@david here are the documents
 * @@robert did you get that thing I sent you? ##blob.txt This is an awesome
 * file I made for you.
 * @@group what are we all thinking?`)
 *
 * => [
 *  { kind: "agent", content: "here are the documents", index: 0, tag:"david" },
 *  { kind: "agent", content: "did you get that thing I sent you?", index: 1, tag: "robert"},
 *  { kind: "file",  content: "This is an awesome\nfile I made for you", index: 2, tag: "./blob.txt"},
 *  { kind: "group", content: "what are we all thinking?", index: 3, tag: "group" }
 * ]
 *
 * If no tags are present, the entire message is treated as @@group.
 */

export type TagPart =
  | { kind: "agent"; tag: string; content: string; index: number }
  | { kind: "group"; tag: "group"; content: string; index: number }
  | { kind: "user";  tag: "user";  content: string; index: number }
  | { kind: "file";  tag: string;  content: string; index: number };

const isWordChar = (ch: string) => /[A-Za-z0-9._-]/.test(ch);
// Allow slashes in filenames for ##... tags
const isFileNameChar = (ch: string) => /[A-Za-z0-9._\-\/]/.test(ch);

export class TagParser {
  static parse(s: string): TagPart[] {
    const text = String(s ?? "");
    if (!text.trim()) return [{ kind: "group", tag: "group", content: "", index: 0 }];

    type TagTok = { kind: "agent" | "group" | "user" | "file"; tag: string; start: number; end: number };
    const toks: TagTok[] = [];

    const pushTok = (t: TagTok) => toks.push(t);

    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      if (ch === "@" && i + 1 < text.length && text[i + 1] === "@") {
        // Parse @@tag
        let j = i + 2;
        let tag = "";
        while (j < text.length && isWordChar(text[j])) { tag += text[j]; j++; }
        if (tag.length > 0) {
          const kind: TagTok["kind"] =
            tag.toLowerCase() === "group" ? "group" :
            tag.toLowerCase() === "user"  ? "user"  :
            "agent";
          pushTok({ kind, tag, start: i, end: j });
          i = j;
          continue;
        }
      } else if (ch === "#" && i + 1 < text.length && text[i + 1] === "#") {
        // Parse ##file or ##file:NAME or ##NAME (filename shorthand, slashes allowed)
        let j = i + 2;
        let token = "";
        // Allow slash in token to support shorthand like ##src/main.ts
        while (j < text.length && isFileNameChar(text[j])) { token += text[j]; j++; }
        // Support both "##file:notes.txt" and "##notes.txt" (or with slashes)
        let tag = token;
        if (token.toLowerCase() === "file" && text[j] === ":") {
          j++;
          let name = "";
          // After "##file:" read until whitespace; this also permits slashes
          while (j < text.length && !/\s/.test(text[j])) { name += text[j]; j++; }
          tag = name || "file.txt";
        }
        if (tag.length > 0) {
          // Normalize to relative path if not absolute and not explicitly relative
          if (!(tag.startsWith("/") || tag.startsWith("."))) {
            tag = "./" + tag;
          }
          pushTok({ kind: "file", tag, start: i, end: j });
          i = j;
          continue;
        }
      }

      i++;
    }

    // If no tags, single group message
    if (toks.length === 0) {
      return [{ kind: "group", tag: "group", content: text.trim(), index: 0 }];
    }

    // Build parts: content of a tag spans until the next tag start
    const parts: TagPart[] = [];
    for (let k = 0; k < toks.length; k++) {
      const cur = toks[k];
      const nextStart = (k + 1 < toks.length) ? toks[k + 1].start : text.length;
      const raw = text.slice(cur.end, nextStart);
      const content = raw.replace(/^\s+/, "").replace(/\s+$/, "");
      const index = k;

      if (cur.kind === "file") {
        parts.push({ kind: "file", tag: cur.tag, content, index });
      } else if (cur.kind === "group") {
        parts.push({ kind: "group", tag: "group", content, index });
      } else if (cur.kind === "user") {
        parts.push({ kind: "user", tag: "user", content, index });
      } else {
        parts.push({ kind: "agent", tag: cur.tag, content, index });
      }
    }

    // If the message begins with plain text before the first tag, treat it as @@group preamble.
    const firstStart = toks[0].start;
    const preamble = text.slice(0, firstStart).trim();
    if (preamble) {
      parts.unshift({ kind: "group", tag: "group", content: preamble, index: -1 });
      // Reindex to remain stable
      let idx = 0;
      for (const p of parts) (p as any).index = idx++;
    }

    return parts;
  }
}
