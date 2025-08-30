import { LLMNoiseFilterPass } from "./llm-noise-filter-pass";

/**
 * Single-pass streaming PDA for LLM noise filtering.
 *
 * Design goals:
 * - Preserve fenced code blocks verbatim, including language tags: ```ts ... ```
 * - Remove analysis/memory/tool_call blocks; unwrap tool_result and <|final_start|>…<|final_end|>.
 * - Handle <|channel|> blocks:
 *   - final: keep @@mentions that appear before <|message|>, drop sentinels (e.g. <|constrain|>), emit mention + " " + message
 *   - final|json: unwrap echo commands
 *   - commentary to=functions sh: drop whole block (incl JSON)
 *   - unknown / non-JSON commentary: drop to newline
 */
export class LLMNoisePDAStream implements LLMNoiseFilterPass {
  private buf = "";
  private removed = 0;
  private inFence = false; // inside ``` ... ```
  private readonly HOLD_BACK = 48; // protect against cutting tags across chunk boundaries

  // Common sentinels
  private static readonly TOK = {
    fence: "```",
    channel: "<|channel|>",
    message: "<|message|>",
    analysisStart: "<|analysis_start|>",
    analysisEnd: "<|analysis_end|>",
    memoryStart: "<|memory_start|>",
    memoryEnd: "<|memory_end|>",
    toolCallStart: "<|tool_call_start|>",
    toolCallEnd: "<|tool_call_end|>",
    toolResultStart: "<|tool_result_start|>",
    toolResultEnd: "<|tool_result_end|>",
    finalStart: "<|final_start|>",
    finalEnd: "<|final_end|>",
    constrain: "<|constrain|>",
  } as const;

  feed(chunk: string): string {
    this.buf += chunk;
    const out = this.process();
    return out;
  }

  flush(): string {
    // If we're still in a fence, it's safest to emit whatever is left verbatim.
    const tail = this.buf;
    this.buf = "";
    this.inFence = false;
    return tail;
  }

  /** Main driver that repeatedly consumes from this.buf and emits cleaned text. */
  private process(): string {
    let emitted = "";

    // Loop until we can't make more progress this call
    while (this.buf.length) {
      if (this.inFence) {
        const close = this.indexAfterFenceClose(this.buf);
        if (close === -1) break; // need more data to close fence
        // emit whole fence
        emitted += this.buf.slice(0, close);
        this.buf = this.buf.slice(close);
        this.inFence = false;
        continue;
      }

      // Find the next interesting boundary (fence start or sentinel)
      const iFence = this.buf.indexOf(LLMNoisePDAStream.TOK.fence);
      const iTag = this.buf.indexOf("<|");
      const iNext =
        iFence === -1 ? iTag : iTag === -1 ? iFence : Math.min(iFence, iTag);

      if (iNext === -1) {
        // No special token; emit safe portion, keep a small holdback
        if (this.buf.length <= this.HOLD_BACK) break;
        const safeLen = this.buf.length - this.HOLD_BACK;
        emitted += this.buf.slice(0, safeLen);
        this.buf = this.buf.slice(safeLen);
        break;
      }

      // Emit plain text before the boundary
      if (iNext > 0) {
        emitted += this.buf.slice(0, iNext);
        this.buf = this.buf.slice(iNext);
      }

      // Boundary handling
      if (this.buf.startsWith(LLMNoisePDAStream.TOK.fence)) {
        // Fence may have a language tag, e.g. ```ts\n ... ```
        const close = this.indexAfterFenceClose(this.buf);
        if (close === -1) {
          // Hold from the start of the fence
          this.inFence = true;
          break;
        } else {
          emitted += this.buf.slice(0, close);
          this.buf = this.buf.slice(close);
          continue;
        }
      }

      // Sentinels
      const s = LLMNoisePDAStream.TOK;
      if (this.buf.startsWith(s.analysisStart)) {
        const end = this.buf.indexOf(s.analysisEnd, s.analysisStart.length);
        if (end === -1) break; // wait
        // drop whole block
        this.removed += end + s.analysisEnd.length;
        this.buf = this.buf.slice(end + s.analysisEnd.length);
        continue;
      }

      if (this.buf.startsWith(s.memoryStart)) {
        const end = this.buf.indexOf(s.memoryEnd, s.memoryStart.length);
        if (end === -1) break;
        this.removed += end + s.memoryEnd.length;
        this.buf = this.buf.slice(end + s.memoryEnd.length);
        continue;
      }

      if (this.buf.startsWith(s.toolCallStart)) {
        const end = this.buf.indexOf(s.toolCallEnd, s.toolCallStart.length);
        if (end === -1) break;
        this.removed += end + s.toolCallEnd.length;
        this.buf = this.buf.slice(end + s.toolCallEnd.length);
        continue;
      }

      if (this.buf.startsWith(s.toolResultStart)) {
        const end = this.buf.indexOf(s.toolResultEnd, s.toolResultStart.length);
        if (end === -1) break;
        const inner = this.buf.slice(
          s.toolResultStart.length,
          end,
        );
        emitted += inner;
        this.buf = this.buf.slice(end + s.toolResultEnd.length);
        continue;
      }

      if (this.buf.startsWith(s.finalStart)) {
        const end = this.buf.indexOf(s.finalEnd, s.finalStart.length);
        if (end === -1) break;
        const inner = this.buf.slice(s.finalStart.length, end);
        emitted += inner;
        this.buf = this.buf.slice(end + s.finalEnd.length);
        continue;
      }

      if (this.buf.startsWith(s.channel)) {
        const out = this.handleChannelBlock();
        if (out === null) break; // need more data
        emitted += out;
        continue;
      }

      // Unknown '<|' sequence — safest is to hold a bit (avoid tearing a tag)
      if (this.buf.length <= this.HOLD_BACK) break;
      emitted += this.buf.slice(0, this.buf.length - this.HOLD_BACK);
      this.buf = this.buf.slice(this.buf.length - this.HOLD_BACK);
      break;
    }

    return emitted;
  }

  /**
   * Handles <|channel|>… blocks.
   * Returns emitted text (possibly empty string), or null if we need more data.
   */
  private handleChannelBlock(): string | null {
    const s = LLMNoisePDAStream.TOK;
    // We expect: <|channel|>HEADER<|message|>PAYLOAD...
    const after = this.buf.slice(s.channel.length);
    const iMsg = after.indexOf(s.message);
    if (iMsg === -1) return null; // wait for <|message|>

    const header = after.slice(0, iMsg).trim(); // e.g. 'final', 'final |json', 'commentary to=functions sh'
    const afterMsg = after.slice(iMsg + s.message.length);

    // FINAL | JSON
    if (/^final\s*\|?\s*json\b/i.test(header)) {
      const startTrim = afterMsg.match(/^\s*/)?.[0].length ?? 0;
      const jsonCandidate = afterMsg.slice(startTrim);
      const j = this.extractJSONObject(jsonCandidate);
      if (!j) return null; // wait for complete JSON
      let out = "";
      try {
        const obj = JSON.parse(j.text);
        const cmd = typeof obj?.cmd === "string" ? obj.cmd.trim() : "";
        const echoed = this.extractEchoText(cmd);
        if (echoed != null) out = echoed;
      } catch {
        // If it isn't valid JSON, emit nothing (conservative).
      }
      // consume whole block
      this.buf = jsonCandidate.slice(j.end) + afterMsg.slice(0, startTrim) /* nothing */; // remainder after JSON
      this.buf = this.buf; // (no-op clarity)
      return out;
    }

    // COMMENTARY to=functions sh — drop whole block including JSON payload
    if (/^commentary\b/i.test(header) && /\bto=functions\b/i.test(header)) {
      const startTrim = afterMsg.match(/^\s*/)?.[0].length ?? 0;
      const jsonCandidate = afterMsg.slice(startTrim);
      const j = this.extractJSONObject(jsonCandidate);
      if (!j) return null; // wait for complete JSON
      // drop block
      this.removed += s.channel.length + iMsg + s.message.length + startTrim + j.end;
      this.buf = jsonCandidate.slice(j.end); // remainder after JSON
      return "";
    }

    // COMMENTARY (unknown / not JSON) or unknown channel — drop up to newline
    if (/^commentary\b/i.test(header) || header.length > 0 && !/^final\b/i.test(header)) {
      const iNL = afterMsg.indexOf("\n");
      if (iNL === -1) return null; // wait for a newline to safely drop
      // drop <|channel|> + header + <|message|> + line
      this.removed += s.channel.length + iMsg + s.message.length + iNL + 1;
      this.buf = afterMsg.slice(iNL + 1);
      return "";
    }

    // FINAL (plain text). Keep @@mentions that appear before <|message|> and drop sentinels.
    if (/^final\b/i.test(header)) {
      const mentionPrefix = this.extractMentions(
        // keep only the region between 'final' and <|message|>
        after.slice(0, iMsg).replace(/^final\b/i, ""),
      );
      // Emit message text until the next sentinel boundary (or all we have)
      const stop = this.findFirstBoundary(afterMsg);
      const msg = stop === -1 ? afterMsg : afterMsg.slice(0, stop);
      const rest = stop === -1 ? "" : afterMsg.slice(stop);
      // consume entire <|channel|>...<|message|> + msg we emitted
      this.buf = rest;
      return (mentionPrefix ? mentionPrefix + (msg ? " " : "") : "") + msg;
    }

    // Fallback: unknown header treated like drop-to-newline
    const iNL = afterMsg.indexOf("\n");
    if (iNL === -1) return null;
    this.removed += s.channel.length + iMsg + s.message.length + iNL + 1;
    this.buf = afterMsg.slice(iNL + 1);
    return "";
  }

  /** First boundary after text: either a fence start "```" or any "<|" sequence. */
  private findFirstBoundary(s: string): number {
    const iFence = s.indexOf(LLMNoisePDAStream.TOK.fence);
    const iTag = s.indexOf("<|");
    if (iFence === -1) return iTag;
    if (iTag === -1) return iFence;
    return Math.min(iFence, iTag);
  }

  /** Extract a completed JSON object starting at s[0] (balanced braces). */
  private extractJSONObject(s: string): { text: string; end: number } | null {
    if (!s || s[0] !== "{") return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (c === "\\") {
          esc = true;
        } else if (c === '"') {
          inStr = false;
        }
      } else {
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) return { text: s.slice(0, i + 1), end: i + 1 };
        }
      }
    }
    return null; // incomplete
  }

  /** Parse echo commands: echo "text", echo 'text', or echo text */
  private extractEchoText(cmd: string): string | null {
    const m = cmd.match(/^echo\s+(?:"([^"]*)"|'([^']*)'|(.*))\s*$/s);
    if (!m) return null;
    return (m[1] ?? m[2] ?? m[3] ?? "").trim();
  }

  /** From pre-message header text, extract any @@mentions, ignoring sentinels (e.g. <|constrain|>). */
  private extractMentions(s: string): string {
    // Drop any <|...|> tokens in this prefix
    const noSentinels = s.replace(/<\|[^|>]+?\|>/g, " ").replace(/\s+/g, " ").trim();
    // Keep only @@mention tokens
    const mentions = noSentinels.match(/@@[A-Za-z0-9_-]+/g) ?? [];
    return mentions.join(" ");
  }

  /** Return index just after the closing ``` of a fenced block, or -1 if incomplete. */
  private indexAfterFenceClose(s: string): number {
    // s starts at some position (maybe the fence start). We accept language tags after opening ``` (until end-of-line).
    if (!s.startsWith(LLMNoisePDAStream.TOK.fence)) return -1;
    // Find the next closing ```
    // Skip the opening ```
    let i = LLMNoisePDAStream.TOK.fence.length;
    // Optionally skip language tag to end of line
    while (i < s.length && s[i] !== "\n") i++;
    if (i < s.length) i++; // consume the newline after opening fence line, if present
    // Search for the closing ```
    const close = s.indexOf(LLMNoisePDAStream.TOK.fence, i);
    if (close === -1) return -1;
    return close + LLMNoisePDAStream.TOK.fence.length;
  }
}
