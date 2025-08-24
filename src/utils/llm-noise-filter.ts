// Drop-in helper: strip OpenAI-Toolformer-style channel/message sentinels.
// - Preserves ```fenced``` blocks verbatim
// - Removes sequences like: <|channel|>commentary to=functions sh<|message|>{"cmd":"..."}.
// - Robust to chunking (keep a small rolling tail between chunks).

export class LLMNoiseFilter {
  private tail = "";

  feed(chunk: string): { cleaned: string; removed: number } {
    const s = this.tail + (chunk ?? "");
    const { cleaned, carry, removed } = stripSentinelsPreservingFences(s);
    this.tail = carry;              // keep a small tail for cross-chunk matches
    return { cleaned, removed };
  }

  flush(): string {
    const out = this.tail;
    this.tail = "";
    return out;
  }
}

function stripSentinelsPreservingFences(s: string): { cleaned: string; carry: string; removed: number } {
  const parts: string[] = [];
  let i = 0, removed = 0;

  while (i < s.length) {
    // Preserve fenced blocks as-is
    if (s.startsWith("```", i)) {
      const j = s.indexOf("```", i + 3);
      if (j < 0) break; // keep as carry until we see the closing fence
      parts.push(s.slice(i, j + 3));
      i = j + 3;
      continue;
    }

    const start = s.indexOf("<|channel|>", i);
    if (start < 0) { parts.push(s.slice(i)); i = s.length; break; }

    // push prefix then consume the sentinel block
    parts.push(s.slice(i, start));
    let k = start + "<|channel|>".length;

    // optional: swallow until <|message|>
    const msgTag = s.indexOf("<|message|>", k);
    if (msgTag < 0) { 
      // Not enough data yet; keep from start as carry
      return { cleaned: parts.join(""), carry: s.slice(start), removed };
    }

    let p = msgTag + "<|message|>".length;

    // Try to consume a JSON object that follows (balanced braces, strings aware)
    const scan = scanJSONObject(s, p);
    if (scan.ok) {
      i = scan.end; 
      removed++;
      continue;
    }

    // If it's not a JSON object, drop the sentinel line up to newline and keep going
    const nl = s.indexOf("\n", p);
    i = nl >= 0 ? nl + 1 : s.length;
    removed++;
  }

  // Keep a bounded carry for partially seen tokens/braces
  const last = parts.join("");
  const carry = s.slice(Math.max(s.length - 512, 0)); // small tail
  return { cleaned: last, carry, removed };
}

function scanJSONObject(s: string, i: number): { ok: boolean; end: number } {
  const n = s.length;
  while (i < n && /\s/.test(s[i]!)) i++;
  if (s[i] !== "{") return { ok: false, end: i };
  let depth = 0, inStr = false, esc = false;

  for (; i < n; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === "\"") { inStr = false; continue; }
    } else {
      if (ch === "\"") { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return { ok: true, end: i + 1 };
      }
    }
  }
  return { ok: false, end: n };
}
