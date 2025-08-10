// tag-parser.ts
export type Tag = { kind: "file" | "agent"; value: string; content: string };

export class TagParser {
  /**
   * Parse tags and return:
   *  - clean: original input with tag tokens removed (whitespace preserved)
   *  - tags: ordered list with per-tag content up to the next tag
   *
   * Supported tags:
   *   @llm:<name>   → kind "agent", value "<name>"
   *   @<name>       → kind "agent", value "<name>"            (optional convenience)
   *   #file:<path>  → kind "file",  value "<path>"
   */
  static parse(input: string): { clean: string; tags: Tag[] } {
    // One regex pass to find all tag tokens with their spans.
    // - @llm:name  or  @name  (letters, digits, underscore, dash)
    // - #file:path (allow . / _ - characters)
    const tagRe =
      /(@llm:([A-Za-z0-9_-]+))|(@([A-Za-z0-9_-]+))|(#file:([A-Za-z0-9._/\-]+))/g;

    type Hit = { start: number; end: number; kind: "agent" | "file"; value: string };
    const hits: Hit[] = [];

    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(input))) {
      const [full] = m;
      const start = m.index;
      const end = start + full.length;

      // m[2] = name after @llm:
      // m[4] = name after bare @
      // m[6] = path after #file:
      if (m[6]) {
        hits.push({ start, end, kind: "file", value: m[6] });
      } else {
        const name = m[2] ?? m[4];
        hits.push({ start, end, kind: "agent", value: name! });
      }
    }

    // Build per-tag content: text after this tag up to the next tag (or end).
    const tags: Tag[] = [];
    for (let i = 0; i < hits.length; i++) {
      const cur = hits[i];
      const nextStart = i + 1 < hits.length ? hits[i + 1].start : input.length;
      const content = input.slice(cur.end, nextStart).trim(); // preserve as-is (including newlines/spaces)
      tags.push({ kind: cur.kind, value: cur.value, content });
    }

    // Build clean string = input with tag tokens removed, but keep everything else exactly.
    // We copy:
    //   [0..first.start) + for each hit: (hit.end..next.start) + tail
    let clean = "";
    let cursor = 0;
    for (const h of hits) {
      if (cursor < h.start) clean += input.slice(cursor, h.start);
      cursor = h.end;
    }
    clean += input.slice(cursor); // tail after last tag

    return { clean, tags };
  }
}
