/**
 * PDA stream filter — streaming implementation
 *
 * Order of operations (streamed):
 *   1) Preserve fenced code blocks verbatim (```…``` at line starts).
 *   2) Scrub meta sentinels as they arrive:
 *        - Drop:    <|memory_start|>…<|memory_end|>, <|analysis_start|>…<|analysis_end|>, <|tool_call_start|>…<|tool_call_end|>
 *        - Unwrap:  <|tool_result_start|>…<|tool_result_end|>, <|final_start|>…<|final_end|>
 *   3) Route channel lines that survive scrubbing:
 *        - <|channel|>final <|constrain|>@@user<|message|>Hello!                 → "@@user Hello!"
 *        - <|channel|>final |json<|message|>{"cmd":"echo \"@@user Hi!\" "}       → "@@user Hi!"
 *        - <|channel|>commentary<|message|>{"ok":true,"stdout":"@@user Done."}   → "@@user Done."
 *        - <|channel|>commentary to=functions sh<|message|>{"cmd":1}             → drop only this channel segment; preserve trailing text
 *        - <|channel|>foo<|message|>not-json-here\n                              → drop that line up to newline
 *
 * Interface contract:
 *   feed(chunk)  → emit any text safe to release now
 *   flush()      → emit all remaining text after finalizing partial states
 */

export type StreamFilter = {
  feed: (chunk: string) => string;
  flush: () => string;
};

/** Public: create a streaming PDA filter */
export function createPDAStreamFilter(): StreamFilter {
  return createStreamingMachine();
}

/** Public: pure function helper built on the streaming machine */
export function filterPDAText(input: string): string {
  const f = createPDAStreamFilter();
  let out = f.feed(input);
  out += f.flush();
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Streaming FSM                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

type State =
  | "TEXT"                      // normal stream (after scrub, before channels)
  | "FENCE"                     // inside ``` code fence (verbatim)
  | "DROP"                      // drop until matching *_end
  | "UNWRAP"                    // unwrap until matching *_end (emit inner)
  | "CH_HEADER"                 // after <|channel|>, collecting header until <|message|>
  | "CH_PAYLOAD_PLAIN"          // final (non-json) payload until newline/flush
  | "CH_PAYLOAD_FINAL_JSON"     // final |json → parse/echo
  | "CH_PAYLOAD_COMM_JSON"      // commentary JSON → stdout
  | "CH_COMMENTARY_TO_FN"       // commentary to=functions → drop json only
  | "CH_DROP_LINE";             // unknown or bad → drop to newline

type DropName = "memory" | "analysis" | "tool_call";
type UnwrapName = "tool_result" | "final";

type ChannelKind = "final" | "commentary" | "unknown";

type ChannelCtx = {
  header: string;
  mention: string | null;
  kind: ChannelKind;
  json: boolean;
  toFunctions: boolean;
  // For plain-final payload accumulated across chunks
  plainPayload: string;
};

function createStreamingMachine(): StreamFilter {
  let buf = "";          // unconsumed input
  let state: State = "TEXT";
  let lineStart = true;  // are we at the start of a line (across feeds)?
  let dropName: DropName | null = null;
  let unwrapName: UnwrapName | null = null;
  let ch: ChannelCtx | null = null;

  function emitSafe(commit: boolean): { out: string; rest: string } {
    let out = "";
    let p = 0; // read pointer into buf

    const len = () => buf.length;
    const at = (i: number) => buf.charCodeAt(i); // fast charCode
    const slice = (a: number, b?: number) => buf.slice(a, b);
    const startsWith = (s: string, i: number) => buf.startsWith(s, i);

    const updateLineStart = (lastIdxExclusive: number) => {
      if (lastIdxExclusive <= 0) return;
      const last = buf.charCodeAt(lastIdxExclusive - 1);
      lineStart = last === 10; // '\n'
    };

    const emitChunk = (a: number, b: number) => {
      if (b > a) {
        out += slice(a, b);
        updateLineStart(b);
      }
      p = b;
    };

    const dropChunk = (a: number, b: number) => {
      // drop: just advance pointer and remember line start
      if (b > a) updateLineStart(b);
      p = b;
    };

    const tryReadTag = (i: number): { name: string; end: number } | null => {
      // Requires '<|'
      if (i + 1 >= len()) return null;
      if (at(i) !== 60 /* < */ || at(i + 1) !== 124 /* | */) return null;
      const close = buf.indexOf("|>", i + 2);
      if (close === -1) return null; // incomplete
      const name = slice(i + 2, close);
      return { name, end: close + 2 };
    };

    const classifyHeader = (header: string): ChannelCtx => {
      const headerNorm = header.trim();
      const mention = parseMention(header);
      const isFinal = /\bfinal\b/i.test(headerNorm);
      const isCommentary = /\bcommentary\b/i.test(headerNorm);
      const json = /\|json\b/i.test(headerNorm);
      const toFunctions = /\bto=functions\b/i.test(headerNorm);
      let kind: ChannelKind = "unknown";
      if (isFinal) kind = "final";
      else if (isCommentary) kind = "commentary";
      return { header, mention, kind, json, toFunctions, plainPayload: "" };
    };

    const finalizePlain = () => {
      if (!ch) return;
      const msg = ch.plainPayload;
      const joined = ch.mention ? joinMentionAndMessage(ch.mention, msg) : msg;
      out += joined;
      ch = null;
    };

    // JSON scanning/consumption starts at index 'i', after optional whitespace.
    // Returns:
    //   - { needMore: true } if object is incomplete and commit === false
    //   - { ok: false, next: j } if doesn't start with '{' (caller decides how to handle)
    //   - { ok: true, next: j, value } when complete (j is index after JSON)
    const scanJSONObject = (
      i: number,
      allowNeedMore: boolean
    ):
      | { needMore: true }
      | { ok: false; next: number }
      | { ok: true; next: number; value: unknown } => {
      // skip whitespace
      let j = i;
      while (j < len() && /\s/.test(buf[j]!)) j++;
      if (j >= len()) return allowNeedMore ? { needMore: true } : { ok: false, next: j };
      if (buf[j] !== "{") return { ok: false, next: j };

      let depth = 0;
      let inString = false;
      let esc = false;

      for (; j < len(); j++) {
        const ch = buf[j]!;
        if (inString) {
          if (esc) {
            esc = false;
          } else if (ch === "\\") {
            esc = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{") {
          depth++;
          continue;
        }
        if (ch === "}") {
          depth--;
          if (depth === 0) {
            const raw = slice(i, j + 1);
            try {
              const value = JSON.parse(raw);
              return { ok: true, next: j + 1, value };
            } catch {
              return { ok: false, next: j + 1 };
            }
          }
        }
      }
      return allowNeedMore ? { needMore: true } : { ok: false, next: j };
    };

    const dropLineFrom = (i: number): { consumed: number; done: boolean } => {
      const nl = buf.indexOf("\n", i);
      if (nl === -1) {
        // drop rest for now (or all at flush)
        if (!commit) return { consumed: i, done: false };
        dropChunk(i, len()); // drop to end on flush
        return { consumed: len(), done: true };
      }
      dropChunk(i, nl + 1); // include newline in drop
      return { consumed: nl + 1, done: true };
    };

    // Main loop
    while (p < len()) {
      if (state === "FENCE") {
        // verbatim passthrough until closing ``` at line start
        if (lineStart) {
          if (p + 3 > len()) {
            if (!commit) break;
          }
          if (p + 3 <= len() && startsWith("```", p)) {
            emitChunk(p, p + 3);
            state = "TEXT";
            continue;
          }
        }
        // emit current char
        emitChunk(p, p + 1);
        continue;
      }

      if (state === "DROP") {
        // drop until matching <|name_end|>
        if (!dropName) dropName = "memory"; // fallback guard
        if (p + 2 > len()) {
          if (!commit) break;
        }
        if (p + 2 <= len() && at(p) === 60 /* < */ && at(p + 1) === 124 /* | */) {
          const t = tryReadTag(p);
          if (!t) {
            if (!commit) break;
            // On flush, drop what's left.
            dropChunk(p, len());
            continue;
          }
          if (t.name === `${dropName}_end`) {
            // consume the end tag and return to TEXT
            dropChunk(p, t.end);
            dropName = null;
            state = "TEXT";
            continue;
          }
          // Drop this tag content and keep searching
          dropChunk(p, t.end);
          continue;
        }
        // Drop a single char
        dropChunk(p, p + 1);
        continue;
      }

      if (state === "UNWRAP") {
        // emit content verbatim until matching <|name_end|>, removing sentinels
        if (!unwrapName) unwrapName = "final";
        if (p + 2 <= len() && at(p) === 60 /* < */ && at(p + 1) === 124 /* | */) {
          const t = tryReadTag(p);
          if (!t) {
            if (!commit) break;
            // No closing tag; on flush just emit remainder.
            emitChunk(p, len());
            continue;
          }
          if (t.name === `${unwrapName}_end`) {
            // swallow end tag (do not emit)
            dropChunk(p, t.end);
            unwrapName = null;
            state = "TEXT";
            continue;
          }
          // Different tag inside—treat as literal content
          emitChunk(p, t.end);
          continue;
        }
        // Plain char as content
        emitChunk(p, p + 1);
        continue;
      }

      if (state === "CH_HEADER") {
        // collect header until <|message|>
        if (p + 2 <= len() && at(p) === 60 /* < */ && at(p + 1) === 124 /* | */) {
          const t = tryReadTag(p);
          if (!t) {
            if (!commit) break;
            // Incomplete channel; drop it on flush to be safe
            dropChunk(p, len());
            state = "TEXT";
            ch = null;
            continue;
          }
          if (t.name === "message") {
            // classify and transition
            const info = classifyHeader(ch!.header);
            ch = info;
            dropChunk(p, t.end); // consume <|message|>
            if (info.kind === "final" && !info.json) {
              state = "CH_PAYLOAD_PLAIN";
            } else if (info.kind === "final" && info.json) {
              state = "CH_PAYLOAD_FINAL_JSON";
            } else if (info.kind === "commentary" && info.toFunctions) {
              state = "CH_COMMENTARY_TO_FN";
            } else if (info.kind === "commentary") {
              state = "CH_PAYLOAD_COMM_JSON";
            } else {
              state = "CH_DROP_LINE";
            }
            continue;
          } else {
            // header-internal tag (e.g., <|constrain|>…), keep it as literal header text
            ch!.header += slice(p, t.end);
            dropChunk(p, t.end);
            continue;
          }
        }
        // normal header char
        ch!.header += slice(p, p + 1);
        dropChunk(p, p + 1);
        continue;
      }

      if (state === "CH_PAYLOAD_PLAIN") {
        // accumulate until newline or flush
        const nl = buf.indexOf("\n", p);
        if (nl === -1) {
          // take everything for now
          ch!.plainPayload += slice(p, len());
          if (!commit) {
            // keep waiting for more text for this line
            p = len();
            break;
          }
          // finalize on flush
          p = len();
          finalizePlain();
          state = "TEXT";
          break;
        } else {
          ch!.plainPayload += slice(p, nl);
          // drop newline (channel line boundary)
          dropChunk(p, nl + 1);
          finalizePlain();
          state = "TEXT";
          continue;
        }
      }

      if (state === "CH_PAYLOAD_FINAL_JSON") {
        const r = scanJSONObject(p, !commit);
        if ("needMore" in r) break;
        if (r.ok) {
          const val = r.value as any;
          const cmd = typeof val?.cmd === "string" ? val.cmd : "";
          const echoed = extractEchoPayload(cmd);
          const outMsg = ch!.mention ? joinMentionAndMessage(ch!.mention, echoed) : echoed;
          out += outMsg;
          dropChunk(p, r.next); // consume the JSON
          ch = null;
          state = "TEXT";
          continue;
        } else {
          // not JSON → drop whole line
          const dropped = dropLineFrom(p);
          if (!dropped.done) break;
          ch = null;
          state = "TEXT";
          continue;
        }
      }

      if (state === "CH_PAYLOAD_COMM_JSON") {
        const r = scanJSONObject(p, !commit);
        if ("needMore" in r) break;
        if (r.ok) {
          const val = r.value as any;
          const stdout = typeof val?.stdout === "string" ? val.stdout : "";
          out += stdout;
          dropChunk(p, r.next); // consume JSON
          ch = null;
          state = "TEXT";
          continue;
        } else {
          // not JSON → drop whole line
          const dropped = dropLineFrom(p);
          if (!dropped.done) break;
          ch = null;
          state = "TEXT";
          continue;
        }
      }

      if (state === "CH_COMMENTARY_TO_FN") {
        const r = scanJSONObject(p, !commit);
        if ("needMore" in r) break;
        if (r.ok) {
          // drop only the JSON payload, preserve trailing text on same line
          dropChunk(p, r.next);
          ch = null;
          state = "TEXT";
          continue;
        } else {
          // malformed → drop to newline
          const dropped = dropLineFrom(p);
          if (!dropped.done) break;
          ch = null;
          state = "TEXT";
          continue;
        }
      }

      if (state === "CH_DROP_LINE") {
        const dropped = dropLineFrom(p);
        if (!dropped.done) break;
        state = "TEXT";
        ch = null;
        continue;
      }

      // ── TEXT state ────────────────────────────────────────────────────────
      // 1) Fence start at line start: ```
      if (state === "TEXT") {
        if (lineStart) {
          if (p + 3 > len()) {
            if (!commit) break;
          }
          if (p + 3 <= len() && startsWith("```", p)) {
            // enter fence & emit the backticks immediately
            emitChunk(p, p + 3);
            state = "FENCE";
            continue;
          }
        }

        // 2) Sentinel start?
        if (p + 1 <= len() && at(p) === 60 /* < */) {
          if (p + 1 >= len()) {
            if (!commit) break;
          }
          if (p + 1 < len() && at(p + 1) === 124 /* | */) {
            const t = tryReadTag(p);
            if (!t) {
              if (!commit) break;
              // On flush with broken tag, just emit it
              emitChunk(p, len());
              continue;
            }
            // Evaluate tag
            const name = t.name;
            // (a) paired drops
            if (name === "memory_start" || name === "analysis_start" || name === "tool_call_start") {
              dropName =
                name === "memory_start"
                  ? "memory"
                  : name === "analysis_start"
                  ? "analysis"
                  : "tool_call";
              // consume the start tag and enter DROP
              dropChunk(p, t.end);
              state = "DROP";
              continue;
            }
            // (b) paired unwraps
            if (name === "tool_result_start" || name === "final_start") {
              unwrapName = name === "final_start" ? "final" : "tool_result";
              // consume the start tag and enter UNWRAP
              dropChunk(p, t.end);
              state = "UNWRAP";
              continue;
            }
            // (c) channel
            if (name === "channel") {
              ch = { header: "", mention: null, kind: "unknown", json: false, toFunctions: false, plainPayload: "" };
              // consume <|channel|> then start collecting header
              dropChunk(p, t.end);
              state = "CH_HEADER";
              continue;
            }
            // (d) message tag outside channel etc → treat literally
            emitChunk(p, t.end);
            continue;
          }
        }

        // 3) Normal char: emit and move on
        emitChunk(p, p + 1);
        continue;
      }
    } // while

    // Keep only unconsumed remainder in buf
    const rest = slice(p);
    return { out, rest };
  }

  return {
    feed(chunk: string) {
      buf += chunk;
      const res = emitSafe(false);
      // Replace buf with the unconsumed remainder
      buf = res.rest;
      return res.out;
    },
    flush() {
      // Finalize any partial states and emit everything left
      let out = "";
      // First, resolve states with commit=true until buffer no longer changes
      // (a single pass is enough because we always consume on commit)
      const res = emitSafe(true);
      buf = res.rest;
      out += res.out;

      // If we're still in a plain-final payload state with pending buffer (rare),
      // finalize it now.
      if (state === "CH_PAYLOAD_PLAIN" && ch) {
        // Whatever remains in buf is the rest of the line for this channel
        ch.plainPayload += buf;
        buf = "";
        out += ch.mention ? joinMentionAndMessage(ch.mention, ch.plainPayload) : ch.plainPayload;
        ch = null;
        state = "TEXT";
      }

      // For UNWRAP with a missing end tag, just emit the tail as-is.
      if (state === "UNWRAP" && buf.length) {
        out += buf;
        buf = "";
        state = "TEXT";
      }

      // For DROP / CH_DROP_LINE with leftover (no newline), drop it.
      if ((state === "DROP" || state === "CH_DROP_LINE" || state === "CH_COMMENTARY_TO_FN" || state === "CH_PAYLOAD_FINAL_JSON" || state === "CH_PAYLOAD_COMM_JSON") && buf.length) {
        buf = "";
        state = "TEXT";
        ch = null;
      }

      // Emit any non-special trailing text (should be empty, but safe)
      if (buf.length) {
        out += buf;
        buf = "";
      }

      return out;
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function parseMention(header: string): string | null {
  // "<|constrain|>@@user" or other @@handle
  const m = header.match(/<\|constrain\|>\s*(@@[\w.-]+)/);
  return m ? m[1] : null;
}

function joinMentionAndMessage(mention: string, message: string): string {
  const body = message.replace(/^\s+/, "");
  return `${mention} ${body}`;
}

/** Extract the payload of a shell echo command (handles quoted/unquoted). */
function extractEchoPayload(cmd: string): string {
  const m = cmd.match(/^\s*echo\s+(["'])([\s\S]*?)\1/);
  if (m) return m[2];
  return cmd.replace(/^\s*echo\s+/, "").trim();
}
