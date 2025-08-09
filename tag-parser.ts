type Tag = { kind: "file" | "agent", value: string };

export class TagParser {
  static parse(input: string): { clean: string; tags: Tag[] } {
    const tags: Tag[] = [];
    const re = /(@agent:[\w\-]+)|(#file:[\w\-./]+)\b/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = re.exec(input))) {
      const [tok] = m;
      if (seen.has(tok)) continue;
      seen.add(tok);
      if (tok.startsWith("@agent:")) tags.push({ kind: "agent", value: tok.slice(5) });
      else tags.push({ kind: "file", value: tok.slice(6) });
    }
    const clean = input.replace(re, "").replace(/\s{2,}/g, " ").trim();
    return { clean, tags };
  }
}