import { tracePass } from "../llm-filter-trace";

/**
 * Unwrap <|channel|>final…<|message|> payloads (JSON or non‑JSON),
 * preserving @@user/##file (and any [TAG:…] protected tokens) that
 * appear between <|channel|> and <|message|>. Fences are preserved
 * verbatim. Non‑JSON with no newline consumes to end‑of‑buffer.
 */
export class FinalChannelPass {
  private tail = "";

  feed(chunk: string) {
    tracePass("FinalChannelPass", "in", { chunk });
    if (!chunk) return { cleaned: "" };

    let s = this.tail + chunk;
    this.tail = "";
    let out = "";
    let i = 0;

    while (i < s.length) {
      // 1) Preserve fenced code verbatim
      if (s.startsWith("```", i)) {
        const j = s.indexOf("```", i + 3);
        if (j < 0) {
          this.tail = s.slice(i);
          tracePass("FinalChannelPass", "out", { cleaned: out, tail: this.tail, note: "carry fence" });
          return { cleaned: out };
        }
        out += s.slice(i, j + 3);
        i = j + 3;
        continue;
      }

      const nextFence = s.indexOf("```", i);
      const start     = s.indexOf("<|channel|>", i);
      const next = start < 0 ? -1 : (nextFence >= 0 ? Math.min(start, nextFence) : start);

      if (next < 0) {
        const carryStart = strictPrefixStart(s, i);
        out += s.slice(i, carryStart);
        this.tail = s.slice(carryStart);
        tracePass("FinalChannelPass", "out", { cleaned: out, tail: this.tail, note: "no token" });
        return { cleaned: out };
      }

      if (next > i) { out += s.slice(i, next); i = next; }
      if (s.startsWith("```", i)) continue;

      // We have a channel; require message
      const afterChan = i + 11;
      const msgIdx = s.indexOf("<|message|>", afterChan);
      if (msgIdx < 0) {
        this.tail = s.slice(i);
        tracePass("FinalChannelPass", "out", { cleaned: out, tail: this.tail, note: "carry channel w/o message" });
        return { cleaned: out };
      }

      const meta          = s.slice(afterChan, msgIdx);
      const payloadStart  = msgIdx + 11;

      // Try JSON first
      const probe = scanJSONObject(s, payloadStart);
      if (probe.ok) {
        const raw = s.slice(payloadStart, probe.end);
        const prefix = collectTags(meta);
        const unwrapped = extractFromJsonOrEcho(raw) ?? raw;
        out += prefix + unwrapped;
        i = probe.end;
        continue;
      }

      // Non‑JSON → newline or end‑of‑buffer
      const nl = s.indexOf("\n", payloadStart);
      const end = nl >= 0 ? nl : s.length;
      const raw = s.slice(payloadStart, end);
      out += collectTags(meta) + raw;
      i = end + (nl >= 0 ? 1 : 0);
    }

    tracePass("FinalChannelPass", "out", { cleaned: out });
    return { cleaned: out };
  }

  flush() { const t = this.tail; this.tail = ""; tracePass("FinalChannelPass", "out", { cleaned: "", tail: t, note: "flush" }); return t; }
}

// ---------- helpers (unchanged) ----------

function collectTags(meta: string): string {
  const masked = meta.match(/\[TAG:[^\]]+\]/g) || [];
  const raw    = meta.match(/@@[A-Za-z0-9_-]+|##[A-Za-z0-9_.\/-]+/g) || [];
  const tags = [...masked, ...raw];
  return tags.length ? tags.join(" ") + " " : "";
}

function extractFromJsonOrEcho(text: string): string | null {
  const t = String(text ?? "").trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      if (typeof j?.stdout === "string") return j.stdout;
      if (typeof j?.output === "string") return j.output;
      if (typeof j?.message === "string") return j.message;
      if (typeof j?.result === "string") return j.result;
      if (typeof j?.cmd === "string") {
        const m = j.cmd.match(/echo\s+(?:"([^"]+)"|'([^']+)'|(@@?[^\s"'].*?))(?:\s|$)/i);
        if (m) return m[1] ?? m[2] ?? m[3] ?? "";
      }
    } catch { /* ignore */ }
  }
  const m = t.match(/echo\s+(?:"([^"]+)"|'([^']+)'|(@@?[^\s"'].*?))(?:\s|$)/i);
  if (m) return m[1] ?? m[2] ?? m[3] ?? "";
  return null;
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

function scanJSONObject(s: string, i: number): { ok: boolean; end: number } {
  const n = s.length;
  while (i < n && /\s/.test(s[i]!)) i++;
  if (s[i] !== "{") return { ok: false, end: i };
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < n; k++) {
    const ch = s[k]!;
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === "\"") inStr = false; }
    else { if (ch === "\"") inStr = true; else if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) return { ok: true, end: k + 1 }; } }
  }
  return { ok: false, end: n };
}
