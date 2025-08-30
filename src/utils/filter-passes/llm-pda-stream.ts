import { LLMNoiseFilterPass } from "./llm-noise-filter-pass";

/** Utility: ensure exactly one space between a mention tag and the message body. */
function joinTagAndMessage(tag: string, body: string): string {
  if (!tag) return body;
  if (tag.startsWith('@@') || tag.startsWith('@')) {
    if (body.length === 0) return tag;
    const needsSpace = !/^\s/.test(body);
    return tag + (needsSpace ? ' ' : '') + body;
  }
  return tag + body;
}

type Chan = 'final' | 'commentary' | 'analysis' | 'tool_call' | 'tool_result' | 'memory' | 'other';

const TOK = {
  CHAN: '<|channel|>',
  CONSTRAIN: '<|constrain|>',
  MSG: '<|message|>',
  FINAL_S: '<|final_start|>',
  FINAL_E: '<|final_end|>',
  MEM_S: '<|memory_start|>',
  MEM_E: '<|memory_end|>',
  ANA_S: '<|analysis_start|>',
  ANA_E: '<|analysis_end|>',
  TCALL_S: '<|tool_call_start|>',
  TCALL_E: '<|tool_call_end|>',
  TRES_S: '<|tool_result_start|>',
  TRES_E: '<|tool_result_end|>',
};

function firstWord(s: string): string {
  const m = s.trim().match(/^([^\s]+)/);
  return (m?.[1] || '').toLowerCase();
}

function indexOfEarliest(haystack: string, from: number, needles: string[]) {
  let at = -1;
  let which = '';
  for (const n of needles) {
    const i = haystack.indexOf(n, from);
    if (i !== -1 && (at === -1 || i < at)) {
      at = i; which = n;
    }
  }
  return { index: at, token: which };
}

function tryParseJsonSlice(s: string): { text: string; end: number; obj: any } | null {
  // Greedy: find the earliest slice ending with a '}' that parses.
  let i = s.indexOf('}');
  while (i !== -1) {
    const slice = s.slice(0, i + 1);
    try {
      const obj = JSON.parse(slice);
      return { text: slice, end: i + 1, obj };
    } catch {
      // keep searching
    }
    i = s.indexOf('}', i + 1);
  }
  return null;
}

/** Extract a JSON echo payload ("echo ...") into its string. */
function jsonEchoToText(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const cmd = obj.cmd;
  if (typeof cmd !== 'string') return null;
  // echo "text" | echo 'text' | echo text   (allow trailing spaces)
  const m = cmd.match(/^\s*echo\s+(?:"([^"]*)"|'([^']*)'|(.+))\s*$/s);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3]) ?? '';
}

export class LLMNoisePDAStream implements LLMNoiseFilterPass {
  private buf = '';
  private inFence = false; // ``` fences

  feed(chunk: string): string {
    this.buf += chunk;
    return this.consumeAvailable(false);
  }

  flush(): string {
    return this.consumeAvailable(true);
  }

  /** Streaming parse; only emits content that is safe to show now. */
  private consumeAvailable(atEOF = false): string {
    let out = '';
    let pos = 0;

    const emit = (s: string) => { out += s; };

    while (true) {
      // If we are inside a code fence, only look for the closing fence.
      if (this.inFence) {
        const endFence = this.buf.indexOf('```', pos);
        if (endFence === -1) {
          // still fenced; everything up to current buffer end is literal
          emit(this.buf.slice(pos));
          this.buf = '';
          return out;
        }
        // emit literal up to and including the closing fence
        emit(this.buf.slice(pos, endFence + 3));
        pos = endFence + 3;
        this.inFence = false;
        // continue the scan after the fence
      }

      // Find next interesting token or code fence
      const { index: nextI, token: nextTok } = indexOfEarliest(
        this.buf,
        pos,
        [
          '```',
          TOK.CHAN,
          TOK.FINAL_S, TOK.MEM_S, TOK.ANA_S, TOK.TCALL_S, TOK.TRES_S,
        ]
      );

      if (nextI === -1) {
        // Nothing special ahead. If EOF, flush all; otherwise, it's safe to emit
        // everything *except* we must not emit the tail if it looks like a partial token.
        if (atEOF) {
          emit(this.buf.slice(pos));
          this.buf = '';
        } else {
          // Keep a small tail if it could start a token (avoid splitting "<|" etc.).
          const tail = this.buf.slice(pos);
          const keep = tail.endsWith('<') || tail.endsWith('<|') || tail.endsWith('<|c') || tail.endsWith('<|ch') ||
                       tail.endsWith('<|f') || tail.endsWith('<|fi') || tail.endsWith('<|fin');
          if (keep) {
            emit(tail.slice(0, -1));
            this.buf = tail.slice(-1);
          } else {
            emit(tail);
            this.buf = '';
          }
        }
        return out;
      }

      // Emit literal text before the token.
      emit(this.buf.slice(pos, nextI));
      pos = nextI;

      // Handle code fence
      if (nextTok === '```') {
        // start fence, emit it and flag fenced mode
        emit('```');
        pos += 3;
        this.inFence = true;
        continue;
      }

      // Now we are at one of our sentinel tokens.
      if (nextTok === TOK.FINAL_S || nextTok === TOK.MEM_S || nextTok === TOK.ANA_S || nextTok === TOK.TCALL_S || nextTok === TOK.TRES_S) {
        const startTok = nextTok;
        const endTok = startTok === TOK.FINAL_S ? TOK.FINAL_E
                    : startTok === TOK.MEM_S   ? TOK.MEM_E
                    : startTok === TOK.ANA_S   ? TOK.ANA_E
                    : startTok === TOK.TCALL_S ? TOK.TCALL_E
                    : /* TRES_S */                TOK.TRES_E;
        const keepBody = startTok === TOK.FINAL_S || startTok === TOK.TRES_S;

        const bodyStart = pos + startTok.length;
        const endAt = this.buf.indexOf(endTok, bodyStart);
        if (endAt === -1) {
          // incomplete; wait unless EOF, in which case treat remainder literally.
          if (!atEOF) {
            // keep the remainder for later
            this.buf = this.buf.slice(pos);
            return out;
          }
          // EOF: if it's a "keep" section, emit its body; else drop it.
          const body = this.buf.slice(bodyStart);
          if (keepBody) emit(body);
          this.buf = '';
          return out;
        }
        const body = this.buf.slice(bodyStart, endAt);
        if (keepBody) emit(body); // unwrap final/tool_result
        // drop or keep done; advance past end token
        pos = endAt + endTok.length;
        continue;
      }

      // Handle <|channel|>… blocks
      if (nextTok === TOK.CHAN) {
        // Structure: <|channel|>channelName [extras] [<|constrain|>X] <|message|> BODY [terminator]
        const afterChan = pos + TOK.CHAN.length;

        const msgAt = this.buf.indexOf(TOK.MSG, afterChan);
        if (msgAt === -1) {
          // need more
          if (!atEOF) {
            this.buf = this.buf.slice(pos);
            return out;
          }
          // EOF with no <|message|>: drop the tail (better safe)
          this.buf = '';
          return out;
        }

        const maybeConstrainAt = this.buf.indexOf(TOK.CONSTRAIN, afterChan);
        const hasConstrain = (maybeConstrainAt !== -1 && maybeConstrainAt < msgAt);

        const headerSegment = this.buf.slice(afterChan, hasConstrain ? maybeConstrainAt : msgAt);
        const channelName = firstWord(headerSegment);
        const constrain = hasConstrain ? this.buf.slice(maybeConstrainAt + TOK.CONSTRAIN.length, msgAt) : '';

        const bodyStart = msgAt + TOK.MSG.length;
        const rest = this.buf.slice(bodyStart);

        // Decide how to find the end of this channel line
        let consumed = 0;
        let payload = '';

        if (channelName === 'commentary') {
          // Special: drop toolformer "to=functions sh" commentary lines entirely.
          if (/\bto=functions\s+sh\b/.test(headerSegment)) {
            // Find a JSON object (if complete) just to know where to cut;
            // otherwise cut at newline or EOF.
            const j = tryParseJsonSlice(rest);
            if (j) {
              consumed = j.end;
            } else {
              const nl = rest.indexOf('\n');
              consumed = nl === -1 ? rest.length : nl + 1;
            }
            // Emit nothing (drop), advance, continue.
            pos = bodyStart + consumed;
            continue;
          }

          const j = tryParseJsonSlice(rest);
          if (!j) {
            // wait for more unless at newline
            const nl = rest.indexOf('\n');
            if (nl === -1 && !atEOF) {
              this.buf = this.buf.slice(pos);
              return out;
            }
            // drop commentary when not JSON (spec says: drop the line)
            consumed = nl === -1 ? rest.length : nl + 1;
            payload = '';
          } else {
            consumed = j.end;
            // commentary emits stdout when present
            try {
              const obj = j.obj;
              if (obj && typeof obj.stdout === 'string') payload = obj.stdout;
            } catch {
              payload = '';
            }
          }
        } else if (channelName === 'final') {
          // final: either |json (echo unwrap) or tag + free text until we hit a terminator
          if (constrain.trim() === '|json') {
            const j = tryParseJsonSlice(rest);
            if (!j) {
              if (!atEOF) {
                this.buf = this.buf.slice(pos);
                return out;
              }
              consumed = rest.length;
              payload = '';
            } else {
              consumed = j.end;
              const echoed = jsonEchoToText(j.obj);
              payload = echoed ?? '';
            }
          } else {
            // normal final: join mention-like constrain (tag) + message
            // The "line" ends at next sentinel or newline or EOF.
            const nextSentinel = indexOfEarliest(rest, 0, [
              TOK.CHAN, TOK.FINAL_S, TOK.MEM_S, TOK.ANA_S, TOK.TCALL_S, TOK.TRES_S, '```'
            ]).index;
            const nlAt = rest.indexOf('\n');
            const endLocal = [
              nlAt === -1 ? Infinity : nlAt + 1,
              nextSentinel === -1 ? Infinity : nextSentinel,
              atEOF ? rest.length : Infinity,
            ].reduce((a, b) => Math.min(a, b), Infinity);

            if (endLocal === Infinity) {
              // need more
              this.buf = this.buf.slice(pos);
              return out;
            }
            consumed = endLocal;
            payload = joinTagAndMessage(constrain.trim(), rest.slice(0, consumed));
          }
        } else if (channelName === 'tool_result') {
          // tool_result emits its body; try to take up to end of JSON if it looks like JSON,
          // else cut at newline or EOF
          const j = tryParseJsonSlice(rest);
          if (j) {
            consumed = j.end;
            payload = this.buf.slice(bodyStart, bodyStart + consumed);
          } else {
            const nl = rest.indexOf('\n');
            if (nl === -1 && !atEOF) {
              this.buf = this.buf.slice(pos);
              return out;
            }
            consumed = nl === -1 ? rest.length : nl + 1;
            payload = rest.slice(0, consumed);
          }
        } else {
          // Unknown/other channel → drop up to newline (spec test: "XY")
          const nl = rest.indexOf('\n');
          if (nl === -1 && !atEOF) {
            this.buf = this.buf.slice(pos);
            return out;
          }
          consumed = nl === -1 ? rest.length : nl + 1;
          payload = ''; // drop
        }

        // Emit payload (if any) and advance cursor
        emit(payload);
        pos = bodyStart + consumed;
        continue;
      }

      // Unreachable safeguard: if we get here, move forward by 1 to avoid loops.
      emit(this.buf[pos]);
      pos += 1;
    } // while
  }
}

export default LLMNoisePDAStream;
