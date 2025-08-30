import { tracePass } from "../llm-filter-trace";

/**
 * Remove only "toolformer" commentary sentinels outside fences:
 *  - shape: <|channel|>commentary to=...<|message|>{payload}
 *  - complete JSON payload -> drop whole sentinel
 *  - non‑JSON -> drop line up to newline
 *  - incomplete across chunk -> keep in tail
 *
 * IMPORTANT: do NOT touch <|channel|>final*, nor plain <|channel|>commentary
 * These must flow to FinalChannelPass for unwrapping.
 */
export class ToolformerSentinelPass {
  private tail = "";

  feed(chunk: string) {
    tracePass("ToolformerSentinelPass", "in", { chunk });
    if (!chunk) return { cleaned: "" };

    let s = this.tail + chunk;
    this.tail = "";
    let out = "";
    let i = 0;

    while (i < s.length) {
      if (s.startsWith("```", i)) {
        const j = s.indexOf("```", i + 3);
        if (j < 0) { this.tail = s.slice(i); tracePass("ToolformerSentinelPass", "out", { cleaned: out, tail: this.tail, note: "carry fence" }); return { cleaned: out }; }
        out += s.slice(i, j + 3); i = j + 3; continue;
      }

      const nextFence = s.indexOf("```", i);
      const start     = s.indexOf("<|channel|>", i);
      const next = start < 0 ? -1 : (nextFence >= 0 ? Math.min(start, nextFence) : start);

      if (next < 0) { out += s.slice(i); tracePass("ToolformerSentinelPass", "out", { cleaned: out }); return { cleaned: out }; }
      if (next > i) { out += s.slice(i, next); i = next; }
      if (s.startsWith("```", i)) continue;

      const afterChan = i + 11;
      const msgIdx = s.indexOf("<|message|>", afterChan);
      if (msgIdx < 0) { this.tail = s.slice(i); tracePass("ToolformerSentinelPass", "out", { cleaned: out, tail: this.tail, note: "carry channel w/o message" }); return { cleaned: out }; }

      const meta = s.slice(afterChan, msgIdx).trim();
      const isToolformerCommentary =
        /^commentary\b/.test(meta) && /\bto=/.test(meta); // true toolformer

      // Leave non‑toolformer (final/final|json/plain commentary) for FinalChannelPass
      if (!isToolformerCommentary) {
        out += s.slice(i, msgIdx + 11);
        i = msgIdx + 11;
        continue;
      }

      // Drop toolformer payload
      const payloadStart = msgIdx + 11;
      const json = scanJSONObject(s, payloadStart);
      if (json.ok) { i = json.end; continue; }

      const nl = s.indexOf("\n", payloadStart);
      if (nl >= 0) { i = nl + 1; continue; }

      this.tail = s.slice(i);
      tracePass("ToolformerSentinelPass", "out", { cleaned: out, tail: this.tail, note: "carry partial toolformer" });
      return { cleaned: out };
    }

    tracePass("ToolformerSentinelPass", "out", { cleaned: out });
    return { cleaned: out };
  }

  flush() {
    const t = this.tail; this.tail = "";
    tracePass("ToolformerSentinelPass", "out", { cleaned: "", tail: t, note: "flush" });
    return t;
  }
}

function scanJSONObject(s: string, i: number): { ok: boolean; end: number } {
  const n = s.length;
  while (i < n && /\s/.test(s[i]!)) i++;
  if (s[i] !== "{") return { ok: false, end: i };
  let depth = 0, inStr = false, esc = false;
  for (; i < n; i++) {
    const ch = s[i]!;
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === "\"") inStr = false; }
    else { if (ch === "\"") inStr = true; else if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) return { ok: true, end: i + 1 }; } }
  }
  return { ok: false, end: n };
}
