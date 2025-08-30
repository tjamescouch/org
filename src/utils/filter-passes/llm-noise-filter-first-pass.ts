// src/utils/filter-passes/llm-noise-filter-first-pass.ts
import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

/**
 * First pass: fast, conservative cleanup of obvious LLM sentinel noise
 * while being safe for streaming.
 *
 * - Removes single-token sentinels like <|constrain|>, <|endoftext|>, etc.
 *   (but deliberately keeps *_start/*_end tokens for later passes)
 * - Strips zero-width characters and control chars (except \n and \t).
 * - Holds back an incomplete "<|" ... "|>" token if chunk boundary splits it.
 */
export class LLMNoiseFilterFirstPass implements LLMNoiseFilterPass {
  private tail = "";

  feed(chunk: string): PassFeedResult {
    const incoming = (chunk ?? "");
    let buf = this.tail + incoming;

    // 1) Remove zero-width and control chars (except \n, \r, \t)
    const beforeLen1 = buf.length;
    buf = buf
      // Zero-width / BOM
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
      // Control chars except tab/newline/carriage-return
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    let removed = beforeLen1 - buf.length;

    // 2) Remove single-token sentinels like <|foo|>, but keep *_start/*_end for later passes
    //    We do two steps: find candidates, then filter in replacer for _start/_end.
    const singleTokenRe = /<\|([A-Za-z0-9:_\-]+)\|>/g;
    buf = buf.replace(singleTokenRe, (_m, name: string) => {
      if (/_start$/i.test(name) || /_end$/i.test(name)) return _m; // keep block sentinels for later passes
      removed += _m.length;
      return "";
    });

    // 3) Determine safe emit index: if an unclosed "<|" appears with no closing "|>", hold it.
    const lastOpen = buf.lastIndexOf("<|");
    let emitUpto = buf.length;
    if (lastOpen !== -1) {
      const closeIdx = buf.indexOf("|>", lastOpen + 2);
      if (closeIdx === -1) {
        emitUpto = lastOpen; // keep potential partial sentinel in tail
      }
    }

    const cleaned = buf.slice(0, emitUpto);
    this.tail = buf.slice(emitUpto);

    return { cleaned, removed };
  }

  flush(): string {
    // On flush, remove any leftover single-token sentinels and spill remainder.
    let buf = this.tail;
    this.tail = "";

    // Remove remaining single-token sentinels (now safe to drop all)
    buf = buf.replace(/<\|[A-Za-z0-9:_\-]+?\|>/g, "");

    // Final zero-width/control cleanup (just in case)
    buf = buf
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    return buf;
  }
}

export default LLMNoiseFilterFirstPass;
