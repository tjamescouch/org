// Fence‑aware pass‑through with strict prefix carry guards.
// Leaves tokens intact and keeps only a STRICT token prefix as carry.
export class LLMNoiseFilterFirstPass {
  private tail = "";
  feed(chunk: string) {
    if (!chunk) return { cleaned: "" };
    let s = this.tail + chunk;
    this.tail = "";
    let out = "";
    let i = 0;

    while (i < s.length) {
      if (s.startsWith("```", i)) {
        const j = s.indexOf("```", i + 3);
        if (j < 0) { this.tail = s.slice(i); return { cleaned: out }; }
        out += s.slice(i, j + 3); i = j + 3; continue;
      }
      const nextFence = s.indexOf("```", i);
      const nextChan  = s.indexOf("<|channel|>", i);
      const nextMsg   = s.indexOf("<|message|>", i);
      let next = Number.MAX_SAFE_INTEGER;
      if (nextFence >= 0) next = Math.min(next, nextFence);
      if (nextChan  >= 0) next = Math.min(next, nextChan);
      if (nextMsg   >= 0) next = Math.min(next, nextMsg);
      if (next === Number.MAX_SAFE_INTEGER) {
        const carryStart = strictPrefixStart(s, i);
        out += s.slice(i, carryStart);
        this.tail = s.slice(carryStart);
        return { cleaned: out };
      }
      if (next > i) { out += s.slice(i, next); i = next; continue; }
      if (s.startsWith("<|channel|>", i)) { out += "<|channel|>"; i += 11; continue; }
      if (s.startsWith("<|message|>", i)) { out += "<|message|>"; i += 11; continue; }
      out += s[i]!; i++;
    }
    return { cleaned: out };
  }
  flush() { const t = this.tail; this.tail = ""; return t; }
}
function strictPrefixStart(s: string, i: number): number {
  const toks = ["```", "<|channel|>", "<|message|>"];
  const n = s.length, maxLen = Math.max(...toks.map(t => t.length)) - 1;
  const win = Math.max(i, n - maxLen);
  for (let t = win; t < n; t++) {
    const suf = s.slice(t);
    if (toks.some(tok => suf.length < tok.length && tok.startsWith(suf))) return t;
  }
  return n;
}
