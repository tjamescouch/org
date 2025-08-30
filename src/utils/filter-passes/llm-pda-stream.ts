import { LLMNoiseFilterPass } from "./llm-noise-filter-pass";

/** Ensure exactly one space between a mention tag and the message body. */
function joinTagAndMessage(tag: string, body: string): string {
  const t = tag.trim();
  if (!t) return body;
  if (t.startsWith("@")) {
    if (!body) return t;
    return t + (body.startsWith(" ") ? "" : " ") + body;
  }
  // Non-mention metadata: simple concat.
  return t + body;
}

type DropKind = "memory" | "analysis" | "tool_call";
type ChanPolicy =
  | "FINAL_MENTION"
  | "FINAL_JSON"
  | "COMMENTARY_STDOUT"
  | "DROP_TO_EOL";

const T = {
  channel: "<|channel|>",
  constrain: "<|constrain|>",
  message: "<|message|>",

  memoryStart: "<|memory_start|>",
  memoryEnd: "<|memory_end|>",

  analysisStart: "<|analysis_start|>",
  analysisEnd: "<|analysis_end|>",

  callStart: "<|tool_call_start|>",
  callEnd: "<|tool_call_end|>",

  resultStart: "<|tool_result_start|>",
  resultEnd: "<|tool_result_end|>",

  finalStart: "<|final_start|>",
  finalEnd: "<|final_end|>",
} as const;

function earliest(haystack: string, from: number, needles: string[]) {
  let best = -1;
  let which = -1;
  for (let i = 0; i < needles.length; i++) {
    const k = haystack.indexOf(needles[i], from);
    if (k !== -1 && (best === -1 || k < best)) {
      best = k;
      which = i;
    }
  }
  return { index: best, which };
}

function unwrapEchoFromJson(s: string): string {
  try {
    const obj = JSON.parse(s.trim());
    const cmd = typeof obj?.cmd === "string" ? obj.cmd : "";
    if (cmd.startsWith("echo ")) {
      let rest = cmd.slice(5).trim();
      // Strip balanced quotes if present.
      if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) {
        rest = rest.slice(1, -1);
      }
      return rest;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function stdoutFromCommentaryJson(s: string): string {
  try {
    const obj = JSON.parse(s.trim());
    if (obj && typeof obj.stdout === "string") return obj.stdout;
  } catch {
    /* ignore */
  }
  return "";
}

interface ChannelState {
  /** Raw text between <|channel|> and either <|constrain|> or <|message|>. */
  meta: string;
  /** Text after <|constrain|> and before <|message|>. */
  constrain: string;
  /** Text after <|message|> (until end-of-line or EOF). */
  message: string;
  stage: "meta" | "constrain" | "message";
  policy?: ChanPolicy;
}

export class LLMNoisePDAStream implements LLMNoiseFilterPass {
  private buf = "";

  // Code-fence state (```).
  private inFence = false;

  // Paired spans
  private drop: DropKind | null = null;
  private inToolResult = false;

  // Channel state
  private ch: ChannelState | null = null;

  feed(chunk: string): string {
    this.buf += chunk;
    return this.consumeAvailable(false);
  }

  flush(): string {
    return this.consumeAvailable(true);
  }

  private consumeAvailable(atEOF: boolean): string {
    let out = "";
    let p = 0;

    const B = () => this.buf; // alias to keep code short

    const take = (n: number) => {
      const s = this.buf.slice(p, n);
      p = n;
      return s;
    };

    const commit = () => {
      // Drop processed part from buffer.
      this.buf = this.buf.slice(p);
      p = 0;
    };

    // MAIN LOOP – keep consuming while we can make progress
    let progressed = true;
    while (progressed) {
      progressed = false;

      // 1) Inside a code fence → pass-through until closing fence ``` .
      if (this.inFence) {
        const k = B().indexOf("```", p);
        if (k !== -1) {
          out += take(k + 3);
          this.inFence = false;
          progressed = true;
          commit();
          continue;
        } else {
          // No terminator yet → emit everything and keep waiting.
          out += take(B().length);
          commit();
          continue;
        }
      }

      // 2) Inside a dropped span (memory/analysis/tool_call)
      if (this.drop) {
        const endTok =
          this.drop === "memory"
            ? T.memoryEnd
            : this.drop === "analysis"
            ? T.analysisEnd
            : T.callEnd;
        const k = B().indexOf(endTok, p);
        if (k !== -1) {
          // Skip thru end token.
          take(k + endTok.length);
          this.drop = null;
          progressed = true;
          commit();
          continue;
        } else {
          // Consume everything (we’re dropping), keep waiting for end.
          take(B().length);
          commit();
          continue;
        }
      }

      // 3) Inside <|tool_result_start|> … <|tool_result_end|> → pass-through.
      if (this.inToolResult) {
        const k = B().indexOf(T.resultEnd, p);
        if (k !== -1) {
          out += take(k) /* body */; // do NOT include end token
          take(k + T.resultEnd.length); // swallow end token
          this.inToolResult = false;
          progressed = true;
          commit();
          continue;
        } else {
          out += take(B().length);
          commit();
          continue;
        }
      }

      // 4) Inside a channel block
      if (this.ch) {
        // Establish policy when we first enter the message stage.
        const ensurePolicy = () => {
          if (!this.ch) return;
          if (this.ch.stage !== "message" || this.ch.policy) return;
          const meta = this.ch.meta.trim();
          const head = meta.split(/\s+/)[0] || "";
          const rest = meta.slice(head.length).trim();

          if (head === "final") {
            if (/\|json\b/.test(rest)) {
              this.ch.policy = "FINAL_JSON";
            } else {
              this.ch.policy = "FINAL_MENTION";
            }
          } else if (head === "commentary") {
            if (/to=/.test(rest)) {
              this.ch.policy = "DROP_TO_EOL";
            } else {
              this.ch.policy = "COMMENTARY_STDOUT";
            }
          } else {
            this.ch.policy = "DROP_TO_EOL";
          }
        };

        if (this.ch.stage === "meta") {
          const { index: k, which } = earliest(B(), p, [T.constrain, T.message]);
          if (k === -1) {
            this.ch.meta += take(B().length); // buffer meta
            commit();
            continue;
          }
          // Accumulate meta up to token
          this.ch.meta += take(k);
          // Advance past token
          take(k + (which === 0 ? T.constrain.length : T.message.length));
          this.ch.stage = which === 0 ? "constrain" : "message";
          progressed = true;
          commit();
          continue;
        }

        if (this.ch.stage === "constrain") {
          const k = B().indexOf(T.message, p);
          if (k === -1) {
            this.ch.constrain += take(B().length);
            commit();
            continue;
          }
          this.ch.constrain += take(k);
          take(k + T.message.length);
          this.ch.stage = "message";
          progressed = true;
          commit();
          continue;
        }

        // stage === 'message'
        ensurePolicy();
        const policy = this.ch.policy as ChanPolicy;

        if (policy === "DROP_TO_EOL") {
          // Drop message to end-of-line (inclusive). If no newline yet, wait.
          const k = B().indexOf("\n", p);
          if (k === -1) {
            // Buffer (but throw away) until we see newline or EOF.
            take(B().length);
            commit();
            if (atEOF) {
              // finalize drop
              this.ch = null;
            }
            continue;
          }
          // consume up to and including newline, then finalize (emit nothing)
          take(k + 1);
          this.ch = null;
          progressed = true;
          commit();
          continue;
        }

        // For FINAL_* and COMMENTARY_STDOUT we buffer until newline or EOF.
        const k = B().indexOf("\n", p);
        if (k === -1) {
          // Buffer all we have for the message, wait for more.
          this.ch.message += take(B().length);
          commit();
          if (atEOF) {
            out += this.finalizeChannel(this.ch);
            this.ch = null;
          }
          continue;
        } else {
          // We have a complete line; do not include newline in message
          this.ch.message += take(k);
          // swallow newline
          take(k + 1);
          out += this.finalizeChannel(this.ch);
          this.ch = null;
          progressed = true;
          commit();
          continue;
        }
      }

      // 5) We’re at top-level: look for the next interesting marker.
      const { index: k, which } = earliest(B(), p, [
        "```",
        T.memoryStart,
        T.analysisStart,
        T.callStart,
        T.resultStart,
        T.finalStart,
        T.channel,
      ]);

      if (k === -1) {
        // Nothing special → emit remainder and stop.
        out += take(B().length);
        commit();
        break;
      }

      // Emit prefix text before the token.
      out += take(k);

      // Handle the token we found.
      switch (which) {
        case 0: // ```
          out += take(k + 3); // include the fence itself
          this.inFence = !this.inFence;
          progressed = true;
          commit();
          break;

        case 1: // <|memory_start|>
          take(k + T.memoryStart.length);
          this.drop = "memory";
          progressed = true;
          commit();
          break;

        case 2: // <|analysis_start|>
          take(k + T.analysisStart.length);
          this.drop = "analysis";
          progressed = true;
          commit();
          break;

        case 3: // <|tool_call_start|>
          take(k + T.callStart.length);
          this.drop = "tool_call";
          progressed = true;
          commit();
          break;

        case 4: // <|tool_result_start|>
          take(k + T.resultStart.length);
          this.inToolResult = true;
          progressed = true;
          commit();
          break;

        case 5: { // <|final_start|> … <|final_end|>
          const end = B().indexOf(T.finalEnd, p);
          if (end === -1) {
            // We don't have a full pair yet → keep token in buffer.
            // Roll back the emitted token text (we didn't actually consume it).
            // Put it back by rewinding p to the position where it started.
            // (Out already has text up to 'k', so we leave it; keep token in buffer.)
            p = k; // leave token in buffer for next round
            out = out.slice(0, out.length - (k - (p - k))); // no-op; just clarity
            // Stop now; await more input.
            commit();
            return out;
          }
          // Emit the content inside the pair.
          take(k + T.finalStart.length); // skip start
          out += take(end); // content between start and end
          take(end + T.finalEnd.length); // skip end
          progressed = true;
          commit();
          break;
        }

        case 6: // <|channel|>
          take(k + T.channel.length);
          this.ch = { meta: "", constrain: "", message: "", stage: "meta" };
          progressed = true;
          commit();
          break;
      }
    }

    // If EOF and we’re still inside a channel waiting for more, finalize.
    if (atEOF && this.ch) {
      out += this.finalizeChannel(this.ch);
      this.ch = null;
      this.buf = ""; // everything consumed at EOF
    }

    // If EOF and we’re inside dropping spans, just drop remainder silently.
    if (atEOF) {
      this.drop = null;
      this.inToolResult = false;
      this.inFence = false;
    }

    return out;
  }

  private finalizeChannel(ch: ChannelState): string {
    const policy = ch.policy as ChanPolicy | undefined;
    if (!policy) {
      // Determine on finalize if not yet decided.
      const meta = ch.meta.trim();
      const head = meta.split(/\s+/)[0] || "";
      const rest = meta.slice(head.length).trim();
      if (head === "final") {
        ch.policy = /\|json\b/.test(rest) ? "FINAL_JSON" : "FINAL_MENTION";
      } else if (head === "commentary") {
        ch.policy = /to=/.test(rest) ? "DROP_TO_EOL" : "COMMENTARY_STDOUT";
      } else {
        ch.policy = "DROP_TO_EOL";
      }
    }

    switch (ch.policy) {
      case "FINAL_JSON":
        return unwrapEchoFromJson(ch.message);

      case "FINAL_MENTION":
        return joinTagAndMessage(ch.constrain, ch.message);

      case "COMMENTARY_STDOUT":
        return stdoutFromCommentaryJson(ch.message);

      case "DROP_TO_EOL":
      default:
        return "";
    }
  }
}
