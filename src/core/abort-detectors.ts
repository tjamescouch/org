// src/core/abort-detectors.ts
// Centralized abort detectors and sanitizer used by AgentModel and chat layer.

export interface AbortDetector {
  name: string;
  // text = cumulative assistant text (stream so far or final)
  // ctx optionally carries recent messages, agent list, or rolling SoC
  check(
    text: string,
    ctx?: { messages?: Array<{ role: string; from?: string; content?: string }>; agents?: string[]; soc?: string }
  ): { index: number; reason: string } | null;
}

/** Registry so models (or runtime) can override detector policy */
class _AbortRegistry {
  private _detectors: AbortDetector[] = [];
  get list(): AbortDetector[] { return this._detectors.slice(); }
  set(list: AbortDetector[]) { this._detectors = list.slice(); }
  add(det: AbortDetector) { this._detectors.push(det); }
  clear() { this._detectors = []; }
}
export const AbortRegistry = new _AbortRegistry();

/** Trim meta/control tags from final assistant text */
export function sanitizeAssistantText(text: string) {
  const s = String(text ?? "");
  if (!s) return { text: s, aborted: false, reason: "" };

  const meta = new RegExp(
    [
      String.raw`<\|\s*(?:im_)?(?:start|end|assistant|system|user|tool)(?:_[a-z0-9]+)?\s*\|>`,
      String.raw`<\s*[a-z0-9_-]+\s*\|\s*commentary\b[^>]*>`,
    ].join("|"),
    "i"
  );
  const m = meta.exec(s);
  if (m) {
    const idx = Math.max(0, m.index);
    return { text: s.slice(0, idx).trimEnd(), aborted: true, reason: "meta/control-tag" };
  }
  return { text: s, aborted: false, reason: "" };
}

/* ---------------- Concrete detectors ---------------- */

export class MetaTagLeakDetector implements AbortDetector {
  name = "meta-tag-leak";
  private re = new RegExp(
    [
      String.raw`<\|\s*(?:im_)?(?:start|end|assistant|system|user|tool)(?:_[a-z0-9]+)?\s*\|>`,
      String.raw`<\s*[a-z0-9_-]+\s*\|\s*commentary\b[^>]*>`,
    ].join("|"),
    "i"
  );
  check(text: string) {
    const m = this.re.exec(text);
    return m ? { index: Math.max(0, m.index), reason: "meta/control-tag" } : null;
  }
}

export class AgentQuoteAbortDetector implements AbortDetector {
  name = "agent-quote";
  constructor(private agents: string[]) {}
  private esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  check(text: string, ctx?: { agents?: string[] }) {
    const list = (ctx?.agents?.length ? ctx!.agents! : this.agents).filter(Boolean);
    if (!list.length) return null;
    const pattern = `(^|\\n)\\s*(?:${list.map(this.esc).join("|")}):\\s`;
    const re = new RegExp(pattern, "i");
    const m = re.exec(text);
    return m ? { index: m.index, reason: "agent-quote" } : null;
  }
}

export class ToolEchoFloodDetector implements AbortDetector {
  name = "tool-echo-flood";
  constructor(private maxJsonEchoes = 2) {}
  check(text: string) {
    const re = /"tool_calls"\s*:\s*\[/g;
    let count = 0, m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      count++;
      if (count > this.maxJsonEchoes) {
        return { index: m.index, reason: `tool-call-json-echo>x${this.maxJsonEchoes}` };
      }
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return null;
  }
}

export class RepetitionAbortDetector implements AbortDetector {
  name = "repetition";
  constructor(private cfg = {
    tailWords: 12,
    maxRepeats: 3,
    minWordsForNovelty: 120,
    minNoveltyRatio: 0.2,
  }) {}
  private tokenize(s: string): string[] {
    return s.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  }
  private esc(w: string) {
    return w.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
  }
  check(text: string) {
    const toks = this.tokenize(text);
    const total = toks.length;
    if (total >= this.cfg.minWordsForNovelty) {
      const uniq = new Set(toks).size;
      const novelty = uniq / total;
      if (novelty < this.cfg.minNoveltyRatio) {
        return { index: text.length, reason: `low-novelty(${novelty.toFixed(2)})` };
      }
    }
    const n = Math.min(this.cfg.tailWords, Math.max(3, Math.floor(total / 4)));
    if (total >= n) {
      const tail = toks.slice(total - n);
      const pattern = "\\b" + tail.map(this.esc).join("\\s+") + "\\b";
      const re = new RegExp(pattern, "g");
      let m: RegExpExecArray | null;
      let count = 0;
      let thirdIndex = -1;
      while ((m = re.exec(text)) !== null) {
        count++;
        if (count === this.cfg.maxRepeats) { thirdIndex = m.index; break; }
        if (re.lastIndex === m.index) re.lastIndex++;
      }
      if (count >= this.cfg.maxRepeats && thirdIndex >= 0) {
        return { index: thirdIndex, reason: `phrase-loop(${n}w x${count})` };
      }
    }
    return null;
  }
}

export class CrossTurnRepetitionDetector implements AbortDetector {
  name = "cross-turn";
  constructor(private cfg = {
    tailWords: 14,
    minChars: 120,
    minNoveltyRatio: 0.18,
    sampleSocChars: 12000,
  }) {}
  private tokenize(s: string): string[] {
    return String(s || "").toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  }
  check(text: string, ctx?: { soc?: string }) {
    const soc: string = ctx && (ctx as any).soc ? String((ctx as any).soc) : "";
    if (!soc || text.length < this.cfg.minChars) return null;

    const toks = this.tokenize(text);
    if (toks.length < this.cfg.tailWords) return null;

    const tailStr = toks.slice(-this.cfg.tailWords).join(" ");
    const socSlice = soc.slice(-this.cfg.sampleSocChars);

    if (socSlice.includes(tailStr)) {
      const idx = Math.max(0, text.toLowerCase().lastIndexOf(tailStr));
      return { index: idx > 0 ? idx : Math.max(0, text.length - tailStr.length), reason: "cross-turn-tail-repeat" };
    }

    const recentSet = new Set(toks.slice(-Math.min(160, toks.length)));
    const socSet = new Set(this.tokenize(socSlice));
    let overlap = 0;
    for (const w of recentSet) if (socSet.has(w)) overlap++;
    const novelty = 1 - (overlap / Math.max(1, recentSet.size));
    if (novelty < this.cfg.minNoveltyRatio) {
      return { index: text.length, reason: `cross-turn-low-novelty(${novelty.toFixed(2)})` };
    }
    return null;
  }
}

export class SpiralPhraseDetector implements AbortDetector {
  name = "spiral-phrases";
  private re = /(^|\n)\s*(?:let(?:’|'|)s (?:run|try)|we need to (?:run|write|check)|it didn't show output\b|now create new file\b)/i;
  check(text: string) {
    const m = this.re.exec(text);
    return m ? { index: m.index, reason: "telltale-phrase" } : null;
  }
}

export class MaxLengthAbortDetector implements AbortDetector {
  name = "max-length";
  constructor(private maxChars = 4000) {}
  check(text: string) {
    if (text.length > this.maxChars) {
      return { index: this.maxChars, reason: `max-chars>${this.maxChars}` };
    }
    return null;
  }
}