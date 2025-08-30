
/**
 * PDA-style single-pass LLM noise filter.
 *
 * This combines the responsibilities of the previous multi-pass pipeline:
 *  - Drop <|analysis_start|>...<|analysis_end|>
 *  - Unwrap <|final_start|>...<|final_end|>
 *  - Drop <|memory_start|>...<|memory_end|>
 *  - Drop <|tool_call_start|>...<|tool_call_end|>
 *  - Unwrap <|tool_result_start|>...<|tool_result_end|>
 *  - Handle Toolformer-y "<|channel|>...<|message|>..." sentinels
 *    - keep @@mentions between channel/message, drop <|constrain|> and noise
 *    - final|json or final :/commentary → parse JSON and prefer .stdout; else parse echo
 *    - commentary to=functions sh → drop the entire sentinel (tool call)
 *    - commentary with JSON → prefer .stdout; else parse echo
 *  - Preserve fenced code blocks verbatim (``` ... ```), even when split across chunks.
 *
 * The class implements a streaming interface understood by LLMNoiseFilter:
 *   - feed(chunk) → { cleaned, removed }
 *   - flush()     → { cleaned, removed }
 *
 * If your project defines a stricter LLMNoiseFilterPass interface,
 * you can change the return shape here – tests that use just strings can grab `.cleaned`.
 */
export interface LLMNoiseFilterPass {
  feed(chunk: string): { cleaned: string; removed: number };
  flush(): { cleaned: string; removed: number };
}

type State =
  | { kind: 'TEXT' }
  | { kind: 'FENCE' }                                                // inside ``` ... ```
  | { kind: 'SKIP_UNTIL'; end: string }                              // analysis/memory/tool_call
  | { kind: 'UNWRAP_UNTIL'; end: string; buffer: string }            // final_start/tool_result
  | { kind: 'CHANNEL_HOLD'; prefixPreserve: string; meta: string }   // after <|channel|> until <|message|>
  | { kind: 'JSON_DROP'; depth: number; inStr: boolean; esc: boolean }           // drop a balanced JSON
  | { kind: 'JSON_CAPTURE'; mode: 'FINAL_JSON'|'COMMENTARY_JSON'; data: string; depth: number; inStr: boolean; esc: boolean; prefixPreserve: string };

const START_TO_END: Record<string, string> = {
  '<|analysis_start|>': '<|analysis_end|>',
  '<|memory_start|>': '<|memory_end|>',
  '<|final_start|>': '<|final_end|>',
  '<|tool_call_start|>': '<|tool_call_end|>',
  '<|tool_result_start|>': '<|tool_result_end|>',
};

// Utility: find earliest index of any needle in haystack starting at `from`.
function indexOfAny(hay: string, from: number, needles: string[]): { i: number; n: string } | null {
  let best = { i: -1, n: '' };
  for (const n of needles) {
    const i = hay.indexOf(n, from);
    if (i !== -1 && (best.i === -1 || i < best.i)) best = { i, n };
  }
  return best.i === -1 ? null : best;
}

// Extract echo command text: echo "text" | echo 'text' | echo text
function unwrapEcho(cmd: string): string | null {
  const m = cmd.trim().match(/^echo\s+(?:"([^"]*)"|'([^']*)'|(.+))\s*$/s);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3]) ?? '';
}

function safeJsonParse(s: string): any | null {
  try { return JSON.parse(s); } catch { return null; }
}

// derive semantics of the "<|channel|>...<|message|>" prelude
function interpretChannelPrelude(raw: string): { mode: 'FINAL_PLAIN'|'FINAL_JSON'|'COMMENTARY_JSON'|'TOOLFORMER_DROP', preserve: string } {
  // preserve @@mentions
  const mentions: string[] = [];
  raw.replace(/@@[a-zA-Z0-9_-]+(?:\s+)?/g, (m) => { mentions.push(m); return m; });
  const preserve = mentions.join('');

  const lower = raw.toLowerCase();
  const isFinal = lower.includes('final');
  const isCommentary = lower.includes('commentary');
  const hasJson = lower.includes('|json') || lower.includes(' json') || lower.includes(':/commentary');
  const hasToolRoute = lower.includes('to=') || lower.includes(' to=functions ') || lower.includes(' sh');

  if (isCommentary && hasToolRoute) return { mode: 'TOOLFORMER_DROP', preserve };
  if (isFinal && hasJson) return { mode: 'FINAL_JSON', preserve };
  if (isCommentary) return { mode: 'COMMENTARY_JSON', preserve };
  return { mode: 'FINAL_PLAIN', preserve };
}

/**
 * PDANoiseFilterPass
 */
export class PDANoiseFilterPass implements LLMNoiseFilterPass {
  private buf = '';
  private out = '';
  private removed = 0;
  private stack: State[] = [{ kind: 'TEXT' }];

  feed(chunk: string): { cleaned: string; removed: number } {
    this.buf += chunk;
    this.process(false);
    const cleaned = this.out;
    this.out = '';
    const removed = this.removed;
    this.removed = 0;
    return { cleaned, removed };
  }

  flush(): { cleaned: string; removed: number } {
    // Best-effort: if we are in TEXT, emit remainder; otherwise drop incomplete structured blocks.
    this.process(true);
    let cleaned = '';
    if (this.top().kind === 'TEXT') {
      cleaned = this.out + this.buf;
    } else if (this.top().kind === 'FENCE') {
      // unterminated fence → emit as-is
      cleaned = this.out + this.buf;
    } else {
      // incomplete structured region → drop carry
      cleaned = this.out;
      this.removed += this.buf.length;
    }
    this.buf = '';
    this.out = '';
    const removed = this.removed;
    this.removed = 0;
    this.stack = [{ kind: 'TEXT' }];
    return { cleaned, removed };
  }

  private top(): State { return this.stack[this.stack.length - 1]; }

  private push(s: State) { this.stack.push(s); }
  private pop() { this.stack.pop(); if (this.stack.length === 0) this.stack.push({ kind: 'TEXT' }); }

  private process(isFlush: boolean) {
    while (this.buf.length > 0) {
      const s = this.top();
      if (s.kind === 'FENCE') {
        const idx = this.buf.indexOf('```');
        if (idx === -1) { this.out += this.buf; this.buf = ''; return; }
        // include closing ```
        this.out += this.buf.slice(0, idx + 3);
        this.buf = this.buf.slice(idx + 3);
        this.pop();
        continue;
      }

      if (s.kind === 'SKIP_UNTIL') {
        const idx = this.buf.indexOf(s.end);
        if (idx === -1) { this.removed += this.buf.length; this.buf = ''; return; }
        // drop up to and including end
        this.removed += idx + s.end.length;
        this.buf = this.buf.slice(idx + s.end.length);
        this.pop();
        continue;
      }

      if (s.kind === 'UNWRAP_UNTIL') {
        const idx = this.buf.indexOf(s.end);
        if (idx === -1) {
          // accumulate until we see the end tag (do not emit yet to avoid duplication on flush)
          s.buffer += this.buf;
          this.buf = '';
          return;
        }
        s.buffer += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + s.end.length);
        // emit the unwrapped payload
        this.out += s.buffer;
        this.pop();
        continue;
      }

      if (s.kind === 'JSON_DROP') {
        const consumed = this.consumeBalancedJson(false);
        if (consumed === null) return; // need more
        this.removed += consumed.length;
        this.buf = this.buf.slice(consumed.length);
        this.pop();
        continue;
      }

      if (s.kind === 'JSON_CAPTURE') {
        const captured = this.consumeBalancedJson(true);
        if (captured === null) return; // need more
        this.buf = this.buf.slice(captured.length);
        // interpret JSON
        const obj = safeJsonParse(captured);
        let text = '';
        if (obj && typeof obj === 'object') {
          if (typeof obj.stdout === 'string') {
            text = obj.stdout;
          } else if (typeof obj.cmd === 'string') {
            text = unwrapEcho(obj.cmd) ?? '';
          }
        } else {
          // not parseable → maybe it was a plain echo line
          const asEcho = unwrapEcho(captured);
          if (asEcho !== null) text = asEcho;
        }
        this.out += s.prefixPreserve + text;
        this.pop();
        continue;
      }

      // TEXT mode and CHANNEL_HOLD are handled together because
      // CHANNEL_HOLD only starts when we see <|channel|>
      if (s.kind === 'CHANNEL_HOLD') {
        // wait until <|message|>
        const msgIdx = this.buf.indexOf('<|message|>');
        if (msgIdx === -1) {
          // carry until we see the marker
          s.meta += this.buf;
          this.buf = '';
          return;
        }
        s.meta += this.buf.slice(0, msgIdx);
        this.buf = this.buf.slice(msgIdx + '<|message|>'.length);

        const { mode, preserve } = interpretChannelPrelude(s.meta);
        // After <|message|>, the body goes until newline or next <|channel|> (we will re-process that token)
        // But for JSON modes, capture a balanced JSON value (brace-aware).
        if (mode === 'TOOLFORMER_DROP') {
          // If body looks like JSON, consume it balanced; otherwise drop to newline
          if (this.buf.trimStart().startsWith('{')) {
            this.push({ kind: 'JSON_DROP', depth: 0, inStr: false, esc: false });
          } else {
            const nl = this.buf.indexOf('\n');
            if (nl === -1) { this.removed += this.buf.length; this.buf = ''; return; }
            this.removed += nl + 1;
            this.buf = this.buf.slice(nl + 1);
          }
        } else if (mode === 'FINAL_JSON' || mode === 'COMMENTARY_JSON') {
          // capture JSON and then emit stdout/echo
          this.push({ kind: 'JSON_CAPTURE', mode, data: '', depth: 0, inStr: false, esc: false, prefixPreserve: preserve });
        } else {
          // FINAL_PLAIN → emit until newline or next sentinel
          const next = indexOfAny(this.buf, 0, ['\n', '<|channel|>']);
          if (!next) {
            // consume everything – nothing suggests a new sentinel, but in streaming keep what we have
            this.out += preserve + this.buf;
            this.buf = '';
          } else {
            if (next.n === '\n') {
              this.out += preserve + this.buf.slice(0, next.i);
              this.buf = this.buf.slice(next.i + 1); // drop newline
            } else {
              // new sentinel starts; emit up to there
              this.out += preserve + this.buf.slice(0, next.i);
              this.buf = this.buf.slice(next.i); // leave the token for the next loop
            }
          }
        }
        this.pop();
        continue;
      }

      // s.kind === 'TEXT'
      // Look for the next interesting token
      const hit = indexOfAny(this.buf, 0, [
        '```',
        '<|channel|>',
        ...Object.keys(START_TO_END),
      ]);
      if (!hit) {
        // No tokens in this buffer; emit everything and exit
        this.out += this.buf;
        this.buf = '';
        return;
      }

      // Emit text before the token
      if (hit.i > 0) {
        this.out += this.buf.slice(0, hit.i);
        this.buf = this.buf.slice(hit.i);
      }

      // Now buffer starts with a token
      if (this.buf.startsWith('```')) {
        // enter fence and emit the opening ``` immediately
        const head = this.buf.slice(0, 3);
        this.out += head;
        this.buf = this.buf.slice(3);
        this.push({ kind: 'FENCE' });
        continue;
      }

      if (this.buf.startsWith('<|channel|>')) {
        // consume the marker and begin the hold
        this.removed += '<|channel|>'.length;
        this.buf = this.buf.slice('<|channel|>'.length);
        this.push({ kind: 'CHANNEL_HOLD', prefixPreserve: '', meta: '' });
        continue;
      }

      // Block constructs with explicit start/end tags
      for (const [start, end] of Object.entries(START_TO_END)) {
        if (this.buf.startsWith(start)) {
          this.removed += start.length;
          this.buf = this.buf.slice(start.length);
          if (start === '<|final_start|>' || start === '<|tool_result_start|>') {
            this.push({ kind: 'UNWRAP_UNTIL', end, buffer: '' });
          } else if (start === '<|analysis_start|>' || start === '<|memory_start|>' || start === '<|tool_call_start|>') {
            this.push({ kind: 'SKIP_UNTIL', end });
          } else {
            // default: skip
            this.push({ kind: 'SKIP_UNTIL', end });
          }
          continue;
        }
      }

      // If we get here, something unexpected began with '<|', drop it conservatively up to the next '|' or '>' or whitespace
      if (this.buf.startsWith('<|')) {
        const m = this.buf.match(/^<\|[^>]*\|>/);
        if (m) {
          this.removed += m[0].length;
          this.buf = this.buf.slice(m[0].length);
          continue;
        }
        // incomplete token → hold until more arrives
        if (!isFlush) return;
        // on flush, drop it
        this.removed += this.buf.length;
        this.buf = '';
        return;
      }
    }
  }

  /** Consume a balanced JSON value from the buffer. Returns the consumed substring or null if incomplete. */
  private consumeBalancedJson(capture: boolean): string | null {
    // skip leading whitespace
    let i = 0;
    while (i < this.buf.length && /\s/.test(this.buf[i])) i++;
    if (i >= this.buf.length) return null;
    if (this.buf[i] !== '{' && this.buf[i] !== '[') {
      // It might be a raw string command like: echo "hi"
      // In capture mode we can try to read till newline, otherwise treat as incomplete and wait
      if (!capture) {
        const nl = this.buf.indexOf('\n', i);
        if (nl === -1) return null;
        return this.buf.slice(0, nl + 1);
      } else {
        const nl = this.buf.indexOf('\n', i);
        if (nl === -1) return this.buf; // best effort
        return this.buf.slice(0, nl + 1);
      }
    }

    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < this.buf.length; j++) {
      const ch = this.buf[j];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\\\') { esc = true; continue; }
        if (ch === '"') { inStr = false; continue; }
      } else {
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) {
            // include the closing brace
            return this.buf.slice(0, j + 1);
          }
        }
      }
    }
    return null; // incomplete
  }
}

export default PDANoiseFilterPass;
