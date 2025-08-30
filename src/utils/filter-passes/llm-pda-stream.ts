// src/utils/filter-passes/llm-pda-stream.ts
// Single-pass streaming cleaner based on a simple push‑down automaton.
//
// This class intentionally **does not** depend on any "tag protector".
// It directly preserves fenced code blocks and ignores sentinels found inside them.
//
// Contract: implements the minimal shape used by the runtime:
//    feed(chunk: string): { cleaned: string }
//    end(): string
//
// Notes
//  - It recognizes paired blocks: memory/analysis/tool_call (drop), tool_result/final (unwrap content).
//  - It understands toolformer-style single-line "<|channel|>…<|message|>…" records:
//      * final + optional <|constrain|>… prefix  → emit "<constrain> + payload"
//      * final|json                             → parse JSON and echo
//      * commentary                             → if JSON has a string "stdout", emit that, else drop
//      * anything else                          → drop until end-of-line
//  - It preserves fenced blocks ```…``` verbatim.
//  - It is robust to arbitrarily small chunk sizes (it keeps enough carry to complete tokens).
//
// This is intentionally conservative: if we are unsure (incomplete token),
// we keep bytes in the carry and emit nothing until we are certain.
//
// The implementation is deliberately straightforward rather than micro‑optimized;
// simplicity/clarity is more important in this safety‑critical path.

import { LLMNoiseFilterPass } from "./llm-noise-filter-pass";


type Mode =
  | "TEXT"
  | "FENCE"
  | "DROP_UNTIL"
  | "EMIT_UNTIL"
  | "CHAN_NAME"
  | "CHAN_PAYLOAD_JSON"
  | "CHAN_PAYLOAD_DROP_EOL"
  | "CHAN_PAYLOAD_PLAIN";

const START = {
  memory: "<|memory_start|>",
  analysis: "<|analysis_start|>",
  toolCall: "<|tool_call_start|>",
  toolResult: "<|tool_result_start|>",
  final: "<|final_start|>",
  channel: "<|channel|>",
  message: "<|message|>",
  constrain: "<|constrain|>",
} as const;

const END = {
  memory: "<|memory_end|>",
  analysis: "<|analysis_end|>",
  toolCall: "<|tool_call_end|>",
  toolResult: "<|tool_result_end|>",
  final: "<|final_end|>",
} as const;

const ALL_TAGS = [
  START.memory,
  END.memory,
  START.analysis,
  END.analysis,
  START.toolCall,
  END.toolCall,
  START.toolResult,
  END.toolResult,
  START.final,
  END.final,
  START.channel,
  START.message,
  START.constrain,
];

const MAX_HOLD = 24; // carry at most this many trailing characters to avoid cutting tokens

function isPartialPrefixOfAnyTag(s: string): boolean {
  for (const t of ALL_TAGS) {
    if (t.startsWith(s)) return true;
  }
  // also treat backtick fences as "tags"
  if ("```".startsWith(s)) return true;
  return false;
}

function trimRightMax(s: string, max: number): [string, string] {
  if (s.length <= max) return ["", s];
  return [s.slice(0, s.length - max), s.slice(s.length - max)];
}

function normalizeChannelName(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function extractEcho(cmd: unknown): string | null {
  if (typeof cmd !== "string") return null;
  const m = cmd.match(/^echo\s+(["'])([\s\S]*?)\1\s*$/);
  return m ? m[2] : null;
}

export class PDAStreamFilter implements LLMNoiseFilterPass {
  private buf = "";
  private mode: Mode = "TEXT";

  private dropEndTag: string | null = null;
  private emitEndTag: string | null = null;

  // channel transient state
  private chanName = "";
  private chanPrefix = ""; // concatenated <|constrain|> payload(s)
  private chanEmitPrefixed = false;

  feed(chunk: string): { cleaned: string } {
    this.buf += chunk;
    const cleaned = this.process(false);
    return { cleaned };
  }

  flush(): string {
    const cleaned = this.process(true);
    // reset internal buffers so this instance can be reused if desired
    this.buf = "";
    this.mode = "TEXT";
    this.dropEndTag = null;
    this.emitEndTag = null;
    this.chanName = "";
    this.chanPrefix = "";
    this.chanEmitPrefixed = false;
    return cleaned;
  }

  // Core state machine
  private process(flush: boolean): string {
    let out = "";
    let i = 0;

    while (true) {
      if (this.mode === "TEXT") {
        // inside normal text: look for the next interesting construct
        const nextFence = this.buf.indexOf("```", i);
        const nextTag = this.buf.indexOf("<|", i);
        let next = -1;
        if (nextFence !== -1 && nextTag !== -1) next = Math.min(nextFence, nextTag);
        else next = nextFence !== -1 ? nextFence : nextTag;

        if (next === -1) {
          // nothing special visible; emit safe prefix but keep a small tail in case a token straddles a boundary
          if (!flush) {
            const [emit, hold] = trimRightMax(this.buf.slice(i), MAX_HOLD);
            out += emit;
            this.buf = hold;
            return out;
          } else {
            out += this.buf.slice(i);
            this.buf = "";
            return out;
          }
        }

        // emit up to the next construct
        out += this.buf.slice(i, next);
        i = next;

        // handle fences
        if (this.buf.startsWith("```", i)) {
          const close = this.buf.indexOf("```", i + 3);
          if (close === -1) {
            if (flush) {
              // no closing fence; just emit remainder and finish
              out += this.buf.slice(i);
              this.buf = "";
              return out;
            }
            // wait for more
            const [emit, hold] = trimRightMax(this.buf.slice(i), 2);
            out += emit;
            this.buf = hold;
            return out;
          } else {
            // whole fenced block available – copy verbatim
            out += this.buf.slice(i, close + 3);
            i = close + 3;
            if (i >= this.buf.length) {
              this.buf = "";
              return out;
            }
            continue;
          }
        }

        // handle tags
        const tagMatch = this.matchAnyTagAt(i);
        if (tagMatch === "partial") {
          if (!flush) {
            const [emit, hold] = trimRightMax(this.buf.slice(i), MAX_HOLD);
            out += emit;
            this.buf = hold;
            return out;
          } else {
            // treat any leftovers as plain text on flush
            out += this.buf.slice(i);
            this.buf = "";
            return out;
          }
        }
        if (!tagMatch) {
          // not a known tag; just emit "<|" and continue
          out += this.buf.slice(i, i + 2);
          i += 2;
          if (i >= this.buf.length) {
            this.buf = "";
            return out;
          }
          continue;
        }

        const { tag, len } = tagMatch;
        // advance over the tag and update state
        i += len;

        switch (tag) {
          case START.memory:
            this.mode = "DROP_UNTIL";
            this.dropEndTag = END.memory;
            // remove consumed prefix
            this.buf = this.buf.slice(i);
            i = 0;
            break;
          case START.analysis:
            this.mode = "DROP_UNTIL";
            this.dropEndTag = END.analysis;
            this.buf = this.buf.slice(i);
            i = 0;
            break;
          case START.toolCall:
            this.mode = "DROP_UNTIL";
            this.dropEndTag = END.toolCall;
            this.buf = this.buf.slice(i);
            i = 0;
            break;
          case START.toolResult:
            this.mode = "EMIT_UNTIL";
            this.emitEndTag = END.toolResult;
            this.buf = this.buf.slice(i);
            i = 0;
            break;
          case START.final:
            this.mode = "EMIT_UNTIL";
            this.emitEndTag = END.final;
            this.buf = this.buf.slice(i);
            i = 0;
            break;
          case START.channel:
            // Start of a single-line sentinel record
            this.mode = "CHAN_NAME";
            this.chanName = "";
            this.chanPrefix = "";
            this.chanEmitPrefixed = false;
            this.buf = this.buf.slice(i);
            i = 0;
            break;
          default:
            // unexpected tag (shouldn't happen)
            // emit the raw tag to avoid data loss
            out += tag;
            this.buf = this.buf.slice(i);
            i = 0;
            break;
        }
      } else if (this.mode === "DROP_UNTIL") {
        if (!this.dropEndTag) {
          // safety
          this.mode = "TEXT";
          continue;
        }
        const endi = this.buf.indexOf(this.dropEndTag);
        if (endi === -1) {
          if (flush) {
            // drop everything
            this.buf = "";
            this.mode = "TEXT";
            continue;
          }
          // keep a small tail to catch the end tag
          const holdN = Math.min(this.dropEndTag.length - 1, MAX_HOLD);
          const cut = Math.max(0, this.buf.length - holdN);
          this.buf = this.buf.slice(cut);
          return out;
        } else {
          // drop up to and including the end tag
          this.buf = this.buf.slice(endi + this.dropEndTag.length);
          this.mode = "TEXT";
          i = 0;
          continue;
        }
      } else if (this.mode === "EMIT_UNTIL") {
        if (!this.emitEndTag) {
          this.mode = "TEXT";
          continue;
        }
        const endi = this.buf.indexOf(this.emitEndTag);
        if (endi === -1) {
          if (flush) {
            out += this.buf;
            this.buf = "";
            this.mode = "TEXT";
            continue;
          }
          // emit most of it but keep a tail in case the end tag starts at the boundary
          const holdN = Math.min(this.emitEndTag.length - 1, MAX_HOLD);
          const cut = Math.max(0, this.buf.length - holdN);
          out += this.buf.slice(0, cut);
          this.buf = this.buf.slice(cut);
          return out;
        } else {
          // emit content up to the end tag, then consume the tag
          out += this.buf.slice(0, endi);
          this.buf = this.buf.slice(endi + this.emitEndTag.length);
          this.mode = "TEXT";
          i = 0;
          continue;
        }
      } else if (this.mode === "CHAN_NAME") {
        // read channel name text until we encounter either <|constrain|> or <|message|>
        const k = this.buf.indexOf("<|");
        if (k === -1) {
          // no further tag visible
          if (flush) {
            // no message → nothing to do, emit nothing
            this.buf = "";
            this.mode = "TEXT";
            continue;
          }
          // wait for more input
          const [emit, hold] = trimRightMax(this.buf, MAX_HOLD);
          // channel name isn't emitted; drop the safe prefix
          this.chanName += emit;
          this.buf = hold;
          return out;
        }
        // accumulate channel name up to next tag
        this.chanName += this.buf.slice(0, k);
        // decide which tag
        const tm = this.matchAnyTagAt(k);
        if (tm === "partial") {
          if (flush) {
            // treat as plain text (malformed)
            this.chanName += this.buf.slice(k);
            this.buf = "";
            this.mode = "TEXT";
            continue;
          }
          // wait for more
          const [emit, hold] = trimRightMax(this.buf.slice(k), MAX_HOLD);
          // drop; we only keep hold for next feed
          this.buf = hold;
          return out;
        }
        if (!tm) {
          // shouldn't happen; just skip "<|" and continue
          this.chanName += this.buf.slice(k, k + 2);
          this.buf = this.buf.slice(k + 2);
          continue;
        }
        const { tag, len } = tm;
        this.buf = this.buf.slice(k + len);
        if (tag === START.constrain) {
          // collect prefix until the next tag; we don't emit tags themselves
          const next = this.buf.indexOf("<|");
          if (next === -1) {
            if (flush) {
              // nothing else; treat remainder as prefix
              this.chanPrefix += this.buf;
              this.buf = "";
              this.mode = "TEXT";
              continue;
            }
            // wait for more
            const [emit, hold] = trimRightMax(this.buf, MAX_HOLD);
            this.chanPrefix += emit;
            this.buf = hold;
            return out;
          } else {
            this.chanPrefix += this.buf.slice(0, next);
            // and continue parsing more tags (could be another constrain or message)
            continue;
          }
        } else if (tag === START.message) {
          // decide how to treat the payload
          const name = normalizeChannelName(this.chanName);
          if (name.startsWith("final") && name.includes("json")) {
            this.mode = "CHAN_PAYLOAD_JSON";
            continue;
          } else if (name === "commentary" || name.startsWith("commentary ")) {
            this.mode = "CHAN_PAYLOAD_JSON";
            continue;
          } else if (name === "final") {
            this.mode = "CHAN_PAYLOAD_PLAIN";
            this.chanEmitPrefixed = false;
            continue;
          } else {
            // unknown channel → drop until EOL
            this.mode = "CHAN_PAYLOAD_DROP_EOL";
            continue;
          }
        } else {
          // Any other tag following the channel name is unexpected; ignore it in name
          this.chanName += tag;
          continue;
        }
      } else if (this.mode === "CHAN_PAYLOAD_PLAIN") {
        // Emit constrained prefix once, then pass through until the next "<|" (start of a new record) or end.
        if (!this.chanEmitPrefixed) {
          out += this.chanPrefix;
          this.chanEmitPrefixed = true;
        }
        const next = this.buf.indexOf("<|");
        if (next === -1) {
          if (flush) {
            out += this.buf;
            this.buf = "";
            this.mode = "TEXT";
            continue;
          }
          // emit all but a small hold to detect a following tag across chunks
          const [emit, hold] = trimRightMax(this.buf, MAX_HOLD);
          out += emit;
          this.buf = hold;
          return out;
        } else {
          out += this.buf.slice(0, next);
          this.buf = this.buf.slice(next);
          this.mode = "TEXT";
          continue;
        }
      } else if (this.mode === "CHAN_PAYLOAD_DROP_EOL") {
        const nl = this.buf.indexOf("\n");
        if (nl === -1) {
          if (flush) {
            // drop remainder
            this.buf = "";
            this.mode = "TEXT";
            continue;
          }
          // keep at most MAX_HOLD to watch for newline later
          const [_, hold] = trimRightMax(this.buf, MAX_HOLD);
          this.buf = hold;
          return out;
        } else {
          // consume up to and including newline, emit nothing
          this.buf = this.buf.slice(nl + 1);
          this.mode = "TEXT";
          continue;
        }
      } else if (this.mode === "CHAN_PAYLOAD_JSON") {
        // Accumulate a full JSON object and then decide what to emit.
        const [jsonStr, consumed] = this.tryTakeJSONObject(this.buf, flush);
        if (jsonStr == null) {
          // need more
          return out;
        }
        // consume from buffer
        this.buf = this.buf.slice(consumed);
        // decide based on channel name
        const name = normalizeChannelName(this.chanName);
        try {
          const obj = JSON.parse(jsonStr);
          let text: string | null = null;
          if (name.startsWith("final") && name.includes("json")) {
            text = extractEcho(obj?.cmd) ?? (typeof obj?.stdout === "string" ? obj.stdout : null);
          } else if (name === "commentary" || name.startsWith("commentary ")) {
            text = typeof obj?.stdout === "string" ? obj.stdout : null;
          }
          if (text) out += text;
        } catch {
          // malformed JSON → drop
        }
        // done with this line
        this.mode = "TEXT";
        continue;
      } else {
        // unreachable
        this.mode = "TEXT";
      }
    }
  }

  private matchAnyTagAt(i: number): { tag: string; len: number } | "partial" | null {
    const slice = this.buf.slice(i);
    // quick check for "<|"
    if (!slice.startsWith("<|")) return null;
    for (const t of ALL_TAGS) {
      if (slice.startsWith(t)) return { tag: t, len: t.length };
      if (t.startsWith(slice)) return "partial";
    }
    return null;
  }

  // Attempts to slice a complete JSON object from `s`, starting at the first "{"
  // after any whitespace. Returns [jsonString, consumedChars] or [null, 0] if incomplete.
  private tryTakeJSONObject(s: string, flush: boolean): [string | null, number] {
    let i = 0;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) return [null, 0];
    // If it isn't a JSON object, drop up to newline (this covers "<|channel|>foo<|message|>not-json...").
    if (s[i] !== "{") {
      const nl = s.indexOf("\n", i);
      if (nl === -1) {
        if (flush) return ["", s.length]; // drop all
        // keep a little to detect newline in the next chunk
        const holdN = Math.min(MAX_HOLD, s.length - i);
        return [null, s.length - holdN];
      }
      return ["", nl + 1]; // drop to end of line
    }

    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = i;
    for (let p = i; p < s.length; p++) {
      const c = s[p];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (c === "\\") {
          esc = true;
        } else if (c === '"') {
          inStr = false;
        }
      } else {
        if (c === '"') {
          inStr = true;
        } else if (c === "{") {
          depth++;
        } else if (c === "}") {
          depth--;
          if (depth === 0) {
            const json = s.slice(start, p + 1);
            return [json, p + 1];
          }
        }
      }
    }
    // need more data
    if (flush) {
      // best effort: attempt to parse what we have
      const json = s.slice(start);
      return [json, s.length];
    }
    return [null, 0];
  }
}
