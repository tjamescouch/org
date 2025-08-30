// src/utils/filter-passes/llm-noise-filter-first-pass.ts
// First-pass cleaner for LLM streaming noise.
// Goal (as exercised by tests):
//  - Preserve anything inside triple backtick code fences verbatim.
//  - Remove "<|constrain|>" tokens outside fences.
//  - Consume "<|channel|>final " tag (and the trailing whitespace) outside fences.
//  - Remove "<|message|>" token outside fences, inserting a single space iff it
//    would otherwise glue two non‑whitespace characters together.
// The class is intentionally streaming-safe (buffers input and emits on end()).

import { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

export class LLMNoiseFilterFirstPass implements LLMNoiseFilterPass {
  private buf = "";

  /** Accumulate chunks; cleaning is performed on end() to keep fence integrity. */
  feed(chunk: string): PassFeedResult {
    this.buf += chunk;
    return { cleaned: "", :emoved: 0 };
  }

  /** Finish the stream and return the cleaned text. */
  flush(): string {
    const out = this.stripOutsideFences(this.buf);
    this.buf = "";
    return out;
  }

  // ---- Internals -----------------------------------------------------------

  /** Split by triple‑backtick fences and only filter outside them. */
  private stripOutsideFences(input: string): string {
    const fenceRe = /```[\s\S]*?```/g;
    let cursor = 0;
    let out = "";
    let m: RegExpExecArray | null;

    while ((m = fenceRe.exec(input)) !== null) {
      // outside part
      out += this.cleanOutside(input.slice(cursor, m.index));
      // fence itself, verbatim
      out += m[0];
      cursor = m.index + m[0].length;
    }
    // tail outside any fence
    out += this.cleanOutside(input.slice(cursor));
    return out;
  }

  /** Apply first‑pass cleanup rules to text that is *not* inside a code fence. */
  private cleanOutside(s: string): string {
    // Drop generic sentinel that sometimes appears between channel and message.
    s = s.replace(/<\|constrain\|>/gi, "");

    // Handle "<|channel|>final" (with optional spaces and with/without "|json").
    // We *remove* "<|channel|>final" and any following spaces, but preserve an
    // optional trailing "|json" so later passes can act on it.
    s = s.replace(
      /<\|channel\|>\s*final(\|json)?\s*/gi,
      (_m, json) => (json ? "|json" : "")
    );

    // Remove "<|message|>" while keeping word boundaries friendly. If we would
    // otherwise glue two non‑whitespace tokens together, insert a single space.
    s = s.replace(/<\|message\|>/g, (match, offset) => {
      const prev = offset > 0 ? s[offset - 1] : "";
      const next = s[offset + match.length] || "";
      const needsSpace =
        prev !== "" && next !== "" && !/\s/.test(prev) && !/\s/.test(next);
      return needsSpace ? " " : "";
    });

    return s;
  }
}

export default LLMNoiseFilterFirstPass;
