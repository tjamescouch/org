/**
 * PDA stream filter — streaming implementation
 *
 * Goals (as exercised by tests):
 * - Channel lines:
 *   - <|channel|>final <|constrain|>@@user<|message|>Hello!  → "@@user Hello!"
 *   - <|channel|>final |json<|message|>{"cmd":"echo \"@@user Hi!\" "} → "@@user Hi!"
 *   - <|channel|>commentary<|message|>{"ok":true,"stdout":"@@user Done."} → "@@user Done."
 *   - <|channel|>commentary to=functions sh<|message|>{"cmd":1} → drop exactly the JSON object; preserve trailing text
 *   - <|channel|>foo<|message|>not-json-here\n → drop that line up to newline
 * - Strip memory/analysis/tool_call blocks; unwrap tool_result:
 *   A<|memory_start|>…<|memory_end|>B<|analysis_start|>…<|analysis_end|>
 *   <|tool_call_start|>…<|tool_call_end|><|tool_result_start|>OK<|tool_result_end|>C
 *   → "ABOKC"
 * - Unwrap <|final_start|>…<|final_end|>
 * - Normalize spacing after @@mention: "@@user /work" and "@@user Hello!"
 * - **Preserve fenced code blocks verbatim**:
 *   A\n```ts\n<|analysis_start|>keep this literal<|analysis_end|>\n```\nB → unchanged
 */

export type StreamFilter = {
  /** Supply a chunk; returns any output that is safe to emit now. */
  feed: (chunk: string) => string;
  /** Finish the stream and return the final transformed output. */
  flush: () => string;
};

/** Public: create a streaming PDA filter */
export function createPDAStreamFilter(): StreamFilter {
  return new PDAStreamingFilter();
}

/** Public: pure helper used by some tests / non-stream paths */
export function filterPDAText(input: string): string {
  const f = createPDAStreamFilter();
  f.feed(input);
  return f.flush();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Implementation                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

type Mode =
  | "NORMAL"
  | "FENCE" // inside ```…``` fence (pass-through)
  | "CHANNEL_HEADER" // collecting header until <|message|>
  | "CHANNEL_FINAL_PLAIN" // collect message until newline or flush
  | "CHANNEL_FINAL_JSON" // parse JSON object then echo-unpack
  | "CHANNEL_COMMENTARY_JSON" // parse JSON object then stdout
  | "CHANNEL_COMMENTARY_DROP" // parse JSON object then drop it
  | "CHANNEL_DROP_LINE" // drop until newline
  | "DROP_META" // memory|analysis|tool_call drop (supports nesting)
  | "UNWRAP_TOOL_RESULT" // pass-through text until tool_result_end
  | "UNWRAP_FINAL"; // pass-through text until final_end

type MetaKind = "memory" | "analysis" | "tool_call";

class PDAStreamingFilter implements StreamFilter {
  // Output buffer for the current feed()/flush() call
  private out = "";

  // Input buffer & position for incremental scanning
  private buf = "";
  private i = 0;

  // Core state
  private mode: Mode = "NORMAL";
  private atLineStart = true;

  // Fences (``` at line start)
  private pendingOpeningTicks = ""; // collects '`' at start of line until we know if it's ``` open
  private fenceCloseTicks = ""; // counts backticks at line starts inside fence

  // Tag lexer (for <|name|>) active in all modes except FENCE
  private tagActive = false;
  private tagBuf = ""; // e.g., "<|analysis_start|>"

  // DROP_META nesting stack
  private metaStack: MetaKind[] = [];

  // UNWRAP_* nesting counters
  private toolResultDepth = 0;
  private finalDepth = 0;

  // CHANNEL context
  private channelHeader = ""; // raw header between <|channel|> and <|message|>
  private channelMention: string | null = null;

  // For final plain payload
  private channelFinalMsg = "";

  // For channel JSON payload (final|json, commentary, commentary drop)
  private jsonActive = false;
  private jsonDepth = 0;
  private jsonInString = false;
  private jsonEscape = false;
  private jsonBuf = "";

  feed(chunk: string): string {
    if (!chunk) return "";
    this.buf += chunk;
    this.process(false);
    const out = this.out;
    this.out = "";
    return out;
  }

  flush(): string {
    this.process(true); // finalize any partial structures

    // If we still have pending opening backticks that never formed a fence, flush them
    if (this.pendingOpeningTicks) {
      this.emit(this.pendingOpeningTicks);
      this.pendingOpeningTicks = "";
    }

    // Finalize channel final-plain at EOF (no newline)
    if (this.mode === "CHANNEL_FINAL_PLAIN") {
      this.emit(this.joinMentionAndMessage(this.channelMention, this.channelFinalMsg));
      this.channelFinalMsg = "";
      this.mode = "NORMAL";
    }

    // Incomplete JSON at EOF → treat as drop (unknown) and emit nothing
    // (tests don't exercise partial JSON; safe fallback)

    // If we were still in fences, nothing special — we streamed the raw text already.

    // Clear any remainder
    const leftover = this.out;
    this.out = "";
    this.buf = "";
    this.i = 0;
    return leftover;
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /* Scanner                                                                */
  /* ────────────────────────────────────────────────────────────────────── */

  private process(finalize: boolean) {
    const len = () => this.buf.length;
    while (this.i < len()) {
      const ch = this.buf[this.i]!;

      // FENCE handling — passthrough verbatim until closing fence
      if (this.mode === "FENCE") {
        this.emitCharFence(ch);
        this.i++;
        continue;
      }

      // Tag lexer runs in all non-fence modes. It must *not* consume header
      // content inside CHANNEL_HEADER except for <|message|>, so we special-case that.
      if (this.tagActive) {
        if (this.consumeTagChar(ch)) {
          // tag is completed & handled
          this.i++;
          continue;
        } else {
          // still inside tag
          this.i++;
          continue;
        }
      }

      // Not parsing a tag right now — handle mode-specific logic.
      switch (this.mode) {
        case "NORMAL": {
          // 1) Fence opening detection at line start: collect backticks until we know.
          if (this.atLineStart && ch === "`") {
            this.pendingOpeningTicks += ch;
            if (this.pendingOpeningTicks.length === 3) {
              // Open a fence
              this.emit(this.pendingOpeningTicks);
              this.pendingOpeningTicks = "";
              this.mode = "FENCE";
              this.fenceCloseTicks = "";
            }
            this.i++;
            continue;
          } else if (this.pendingOpeningTicks) {
            // Not another backtick at line start → flush collected ticks as normal text
            this.emit(this.pendingOpeningTicks);
            this.pendingOpeningTicks = "";
          }

          // 2) Structural tags
          if (ch === "<") {
            this.tagActive = true;
            this.tagBuf = "<";
            this.i++;
            continue;
          }

          // 3) Plain text
          this.emitCharAdvanceLine(ch);
          this.i++;
          continue;
        }

        case "CHANNEL_HEADER": {
          // Only sentinel we must act on here is <|message|>; all other <|…|> are literal header content.
          if (ch === "<") {
            // Try to see if the entire "<|message|>" sentinel arrives (incrementally).
            // We borrow the tag lexer but route unknown tags back into header as literal.
            this.tagActive = true;
            this.tagBuf = "<";
            this.i++;
            continue;
          }

          // Otherwise it's plain header text
          this.channelHeader += ch;
          if (ch === "\n") this.atLineStart = true;
          else this.atLineStart = false;
          this.i++;
          continue;
        }

        case "CHANNEL_FINAL_PLAIN": {
          if (ch === "\n") {
            // finalize this channel-line
            const out = this.joinMentionAndMessage(this.channelMention, this.channelFinalMsg);
            this.emit(out);
            this.channelFinalMsg = "";
            this.mode = "NORMAL";
            this.atLineStart = true;
            this.i++;
            continue;
          }
          this.channelFinalMsg += ch;
          this.atLineStart = false;
          this.i++;
          continue;
        }

        case "CHANNEL_FINAL_JSON":
        case "CHANNEL_COMMENTARY_JSON":
        case "CHANNEL_COMMENTARY_DROP": {
          // Stream a JSON object starting at the next non-space. When complete, act accordingly.
          if (!this.jsonActive) {
            if (/\s/.test(ch)) {
              // ignore leading whitespace before object
              this.consumePlainForLine(ch);
              this.i++;
              continue;
            }
            if (ch !== "{") {
              // Not JSON → for safety drop this channel line to newline
              this.mode = "CHANNEL_DROP_LINE";
              continue;
            }
            this.jsonActive = true;
            this.jsonDepth = 1;
            this.jsonInString = false;
            this.jsonEscape = false;
            this.jsonBuf = "{";
            this.i++;
            continue;
          }

          // JSON is active — accumulate safely
          this.jsonBuf += ch;
          if (this.jsonInString) {
            if (this.jsonEscape) {
              this.jsonEscape = false;
            } else if (ch === "\\") {
              this.jsonEscape = true;
            } else if (ch === '"') {
              this.jsonInString = false;
            }
          } else {
            if (ch === '"') {
              this.jsonInString = true;
            } else if (ch === "{") {
              this.jsonDepth++;
            } else if (ch === "}") {
              this.jsonDepth--;
              if (this.jsonDepth === 0) {
                // Complete JSON object
                const parsed = this.tryParseJSON(this.jsonBuf);
                // reset JSON state first
                const mode = this.mode;
                this.jsonActive = false;
                this.jsonBuf = "";
                this.jsonDepth = 0;
                this.jsonInString = false;
                this.jsonEscape = false;

                if (parsed.ok) {
                  if (mode === "CHANNEL_FINAL_JSON") {
                    const cmd = typeof parsed.value?.cmd === "string" ? parsed.value.cmd : "";
                    const echoed = this.extractEchoPayload(cmd);
                    this.emit(this.joinMentionAndMessage(this.channelMention, echoed));
                  } else if (mode === "CHANNEL_COMMENTARY_JSON") {
                    const stdout =
                      parsed.value && typeof (parsed.value as any).stdout === "string"
                        ? (parsed.value as any).stdout
                        : "";
                    this.emit(stdout);
                  } else {
                    // DROP (commentary to=functions sh)
                    // — intentionally emit nothing
                  }
                  this.mode = "NORMAL";
                } else {
                  // Bad JSON → drop to newline
                  this.mode = "CHANNEL_DROP_LINE";
                }
              }
            } else if (ch === "\n") {
              // Newlines can appear inside strings only; hitting one outside JSON is malformed → drop line
              if (!this.jsonInString) {
                this.mode = "CHANNEL_DROP_LINE";
              }
            }
          }
          this.i++;
          continue;
        }

        case "CHANNEL_DROP_LINE": {
          if (ch === "\n") {
            // drop newline and return to NORMAL
            this.atLineStart = true;
            this.mode = "NORMAL";
            this.i++;
            continue;
          }
          // else keep dropping
          this.i++;
          continue;
        }

        case "DROP_META": {
          // Drop everything until the metaStack is empty
          if (ch === "<") {
            this.tagActive = true;
            this.tagBuf = "<";
            this.i++;
            continue;
          }
          // otherwise ignore character
          if (ch === "\n") this.atLineStart = true;
          else this.atLineStart = false;
          this.i++;
          continue;
        }

        case "UNWRAP_TOOL_RESULT": {
          if (ch === "<") {
            this.tagActive = true;
            this.tagBuf = "<";
            this.i++;
            continue;
          }
          // Emit content literally until we see tool_result_end
          this.emitCharAdvanceLine(ch);
          this.i++;
          continue;
        }

        case "UNWRAP_FINAL": {
          if (ch === "<") {
            this.tagActive = true;
            this.tagBuf = "<";
            this.i++;
            continue;
          }
          // Emit content literally until we see final_end
          this.emitCharAdvanceLine(ch);
          this.i++;
          continue;
        }
      }
    }

    // End-of-buffer: if we are at EOF (flush), finalize a few partials.
    if (finalize) {
      // If we were collecting opening ticks and never formed a fence, they'll be flushed by flush()
      // If we were in CHANNEL_FINAL_PLAIN without newline, finalize in flush()
      // Incomplete JSON: silently drop.
    }

    // Drop the consumed prefix of buf to avoid unbounded growth
    if (this.i > 4096) {
      this.buf = this.buf.slice(this.i);
      this.i = 0;
    }
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /* Tag handling                                                           */
  /* ────────────────────────────────────────────────────────────────────── */

  /**
   * Incremental tag reader. Returns true if it consumed `ch` and completed a tag.
   * When a tag completes, it is *not* emitted literally; we route its semantics.
   */
  private consumeTagChar(ch: string): boolean {
    this.tagBuf += ch;

    // Very early rejection: "<" followed by non "|" → not a sentinel. Flush '<' as text.
    if (this.tagBuf.length === 2 && this.tagBuf !== "<|") {
      // It wasn't a tag; emit literal '<' then continue processing current char in normal mode.
      const leftover = this.tagBuf.slice(1); // the char other than '<'
      this.tagActive = false;
      this.tagBuf = "";
      // emit '<'
      this.emitCharAdvanceLine("<");
      // Re-process the second char in current mode by not consuming it here
      return false;
    }

    // Complete sentinel when we see the trailing "|>"
    if (this.tagBuf.length >= 4 && this.tagBuf.endsWith("|>")) {
      const name = this.tagBuf.slice(2, -2); // inside <|...|>
      this.tagActive = false;
      this.tagBuf = "";
      this.handleTag(name);
      return true;
    }

    return true; // still within tag
  }

  private handleTag(name: string) {
    // CHANNEL HEADER special-case: only <|message|> matters. Other tags are literal header content.
    if (this.mode === "CHANNEL_HEADER") {
      if (name === "message") {
        // finalize header, decide channel mode
        const headerNorm = this.channelHeader.trim();
        const headerLower = headerNorm.toLowerCase();
        this.channelMention = this.parseMention(this.channelHeader);

        // commentary to=functions sh
        if (/\bcommentary\b/.test(headerLower) && /\bto=functions\b/.test(headerLower)) {
          this.mode = "CHANNEL_COMMENTARY_DROP";
          return;
        }

        // commentary (JSON -> stdout)
        if (/^commentary\b/.test(headerLower)) {
          this.mode = "CHANNEL_COMMENTARY_JSON";
          return;
        }

        // final
        if (/^final\b/.test(headerLower)) {
          if (/\|json\b/.test(headerNorm)) {
            this.mode = "CHANNEL_FINAL_JSON";
          } else {
            this.mode = "CHANNEL_FINAL_PLAIN";
            this.channelFinalMsg = "";
          }
          return;
        }

        // unknown → drop until newline
        this.mode = "CHANNEL_DROP_LINE";
        return;
      } else {
        // Treat any other tag literally inside the header
        this.channelHeader += `<|${name}|>`;
        return;
      }
    }

    // DROP_META nesting and ends
    if (name === "memory_start" || name === "analysis_start" || name === "tool_call_start") {
      this.metaStack.push(name.replace("_start", "") as MetaKind);
      this.mode = "DROP_META";
      return;
    }
    if (name === "memory_end" || name === "analysis_end" || name === "tool_call_end") {
      // Pop the most recent occurrence matching this type
      const kind = name.replace("_end", "") as MetaKind;
      for (let k = this.metaStack.length - 1; k >= 0; k--) {
        if (this.metaStack[k] === kind) {
          this.metaStack.splice(k, 1);
          break;
        }
      }
      if (this.metaStack.length === 0 && this.mode === "DROP_META") {
        this.mode = "NORMAL";
      }
      return;
    }

    // tool_result unwrap
    if (name === "tool_result_start") {
      this.toolResultDepth++;
      this.mode = "UNWRAP_TOOL_RESULT";
      return;
    }
    if (name === "tool_result_end") {
      if (this.toolResultDepth > 0) this.toolResultDepth--;
      if (this.toolResultDepth === 0) this.mode = "NORMAL";
      return;
    }

    // final unwrap block
    if (name === "final_start") {
      this.finalDepth++;
      this.mode = "UNWRAP_FINAL";
      return;
    }
    if (name === "final_end") {
      if (this.finalDepth > 0) this.finalDepth--;
      if (this.finalDepth === 0) this.mode = "NORMAL";
      return;
    }

    // channel start
    if (name === "channel") {
      this.mode = "CHANNEL_HEADER";
      this.channelHeader = "";
      this.channelMention = null;
      return;
    }

    // message tag outside a channel header is a no-op (treat as literal)
    if (name === "message") {
      this.emit("<|message|>");
      return;
    }

    // Any other unknown sentinel outside of CHANNEL_HEADER → treat as literal text.
    this.emit(`<|${name}|>`);
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /* Small helpers                                                          */
  /* ────────────────────────────────────────────────────────────────────── */

  private emit(s: string) {
    if (!s) return;
    this.out += s;
    // Maintain atLineStart according to last char
    const last = s[s.length - 1];
    this.atLineStart = last === "\n";
  }

  private emitCharAdvanceLine(ch: string) {
    this.out += ch;
    if (ch === "\n") this.atLineStart = true;
    else this.atLineStart = false;
  }

  private emitCharFence(ch: string) {
    // Inside a fence we stream literally and detect closing ``` at line start
    this.out += ch;

    if (ch === "\n") {
      this.atLineStart = true;
      this.fenceCloseTicks = "";
      return;
    }

    if (this.atLineStart) {
      if (ch === "`") {
        this.fenceCloseTicks += ch;
        if (this.fenceCloseTicks.length === 3) {
          // Closing fence consumed
          this.mode = "NORMAL";
          this.atLineStart = false; // we are after the 3rd backtick
          this.fenceCloseTicks = "";
        }
      } else {
        // Not a backtick at line start → no close candidate
        this.atLineStart = false;
        this.fenceCloseTicks = "";
      }
    } else {
      // middle of line
      this.atLineStart = false;
    }
  }

  private consumePlainForLine(ch: string) {
    // Utility used while skipping whitespace before JSON.
    if (ch === "\n") this.atLineStart = true;
    else this.atLineStart = false;
  }

  private parseMention(header: string): string | null {
    // Look for "<|constrain|>@@user" (or @@something). Keep the literal mention.
    const m = header.match(/<\|constrain\|>\s*(@@[\w.-]+)/);
    return m ? m[1] : null;
  }

  private joinMentionAndMessage(mention: string | null, message: string): string {
    const body = message.replace(/^\s+/, "");
    return mention ? `${mention} ${body}` : body;
  }

  /** Extract the payload of a shell echo command: echo "x" | echo 'x' | echo x */
  private extractEchoPayload(cmd: string): string {
    const m = cmd.match(/^\s*echo\s+(["'])([\s\S]*?)\1/);
    if (m) return m[2];
    return cmd.replace(/^\s*echo\s+/, "").trim();
  }

  private tryParseJSON(s: string): { ok: true; value: any } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch {
      return { ok: false };
    }
  }
}
