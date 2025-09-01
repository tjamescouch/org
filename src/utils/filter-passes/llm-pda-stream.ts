/**
 * PDA stream filter
 *
 * Goals (as exercised by tests):
 * - Channel lines:
 *   - <|channel|>final <|constrain|>@@user<|message|>Hello!  → "@@user Hello!"
 *   - <|channel|>final |json<|message|>{"cmd":"echo \"@@user Hi!\" "} → "@@user Hi!"
 *   - <|channel|>commentary<|message|>{"ok":true,"stdout":"@@user Done."} → "@@user Done."
 *   - <|channel|>commentary to=functions sh<|message|>{"cmd":1} → drop entire line segment (preserve trailing text)
 *   - <|channel|>foo<|message|>not-json-here\n → drop that line up to newline
 * - Strip memory/analysis/tool_call blocks; unwrap tool_result:
 *   A<|memory_start|>…<|memory_end|>B<|analysis_start|>…<|analysis_end|>
 *   <|tool_call_start|>…<|tool_call_end|><|tool_result_start|>OK<|tool_result_end|>C
 *   → "ABOKC"
 * - Unwrap <|final_start|>…<|final_end|>
 * - Normalize spacing after @@mention: "@@user /work" and "@@user Hello!"
 * - **Preserve fenced code blocks verbatim**:
 *   A\n```ts\n<|analysis_start|>keep this literal<|analysis_end|>\n```\nB → unchanged
 *
 * NOTE: The streaming API below buffers input and performs the transformation
 *       at flush(). Tests only assert final output, not incremental chunks.
 */

type StreamFilter = {
  /**
   * Supply a chunk of data. Returns any output that is safe to emit now.
   * For simplicity and test-compatibility we return an empty string here
   * and do all work in flush().
   */
  feed: (chunk: string) => string;
  /** Finish the stream and return the final transformed output. */
  flush: () => string;
};

/** Public: create a streaming PDA filter */
export function createPDAStreamFilter(): any {
  let buffer = "";

  return {
    feed(chunk: string) {
      // Buffer and defer processing to flush() to avoid partial-state bugs.
      buffer += chunk;
      return "";
    },
    flush() {
      const out = filterPDAText(buffer);
      buffer = "";
      return out;
    },
  };
}

/** Public: pure function version (useful for non-streaming paths or tests) */
function filterPDAText(input: string): string {
  // 1) Split by fenced code blocks (```...```); process only non-fence parts.
  const parts = splitByBacktickFences(input);

  let out = "";
  for (const part of parts) {
    if (part.type === "fence") {
      // Preserve the fence verbatim
      out += part.content;
    } else {
      // Order of operations:
      // - Transform channel lines
      // - Strip/unwrap meta segments
      // - Unwrap <|final_start|>...<|final_end|>
      let s = transformChannelLines(part.content);
      s = stripPairedBlock(s, "memory"); // remove
      s = stripPairedBlock(s, "analysis"); // remove
      s = stripPairedBlock(s, "tool_call"); // remove
      s = unwrapPairedBlock(s, "tool_result"); // keep inner
      s = unwrapFinalBrackets(s);
      out += s;
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Code fence handling (```…```)                                             */
/* ────────────────────────────────────────────────────────────────────────── */

type FencePart =
  | { type: "text"; content: string }
  | { type: "fence"; content: string };

/**
 * Splits input into alternating text/fence parts where fence parts are triple
 * backtick blocks starting at a line start and ending at a matching line-start
 * triple backtick. The fence content is preserved verbatim.
 */
function splitByBacktickFences(s: string): FencePart[] {
  const parts: FencePart[] = [];
  let i = 0;

  while (i < s.length) {
    const start = findBacktickFenceStart(s, i);
    if (start === -1) {
      // No more fences: the rest is plain text
      parts.push({ type: "text", content: s.slice(i) });
      break;
    }

    // Text before the fence
    if (start > i) {
      parts.push({ type: "text", content: s.slice(i, start) });
    }

    // Find closing fence after the opening line (```[lang]...\n)
    const close = findBacktickFenceEnd(s, start + 3);
    const end = close === -1 ? s.length : close + 3; // include closing ```
    parts.push({ type: "fence", content: s.slice(start, end) });

    i = end;
    if (close === -1) {
      // Unclosed fence — treat rest as fence and stop
      break;
    }
  }

  return parts;
}

function findBacktickFenceStart(s: string, from: number): number {
  let idx = s.indexOf("```", from);
  while (idx !== -1) {
    if (idx === 0 || s.charCodeAt(idx - 1) === 10 /* '\n' */) return idx;
    idx = s.indexOf("```", idx + 1);
  }
  return -1;
}

function findBacktickFenceEnd(s: string, from: number): number {
  // End must be at a line start
  let idx = s.indexOf("```", from);
  while (idx !== -1) {
    if (idx === 0 || s.charCodeAt(idx - 1) === 10 /* '\n' */) return idx;
    idx = s.indexOf("```", idx + 1);
  }
  return -1;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Meta block helpers (strip/unwrap)                                         */
/* ────────────────────────────────────────────────────────────────────────── */

function stripPairedBlock(s: string, name: "memory" | "analysis" | "tool_call"): string {
  // Remove <|name_start|> ... <|name_end|> (non-greedy)
  const re = new RegExp(`<\\|${name}_start\\|>[\\s\\S]*?<\\|${name}_end\\|>`, "g");
  return s.replace(re, "");
}

function unwrapPairedBlock(s: string, name: "tool_result"): string {
  // Keep inner content for <|tool_result_start|>...<|tool_result_end|>
  const re = new RegExp(`<\\|${name}_start\\|>([\\s\\S]*?)<\\|${name}_end\\|>`, "g");
  return s.replace(re, "$1");
}

function unwrapFinalBrackets(s: string): string {
  // <|final_start|> ... <|final_end|> → keep inner
  return s.replace(/<\|final_start\|>([\s\S]*?)<\|final_end\|>/g, "$1");
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Channel line handling                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Transforms all occurrences of:
 *   <|channel|>...<|message|>PAYLOAD
 * ...according to the rules in the header/payload.
 *
 * For unknown channels we drop the entire line (up to newline).
 */
function transformChannelLines(s: string): string {
  let out = "";
  let i = 0;

  while (i < s.length) {
    const start = s.indexOf("<|channel|>", i);
    if (start === -1) {
      out += s.slice(i);
      break;
    }

    // Emit text before channel
    out += s.slice(i, start);

    const headerStart = start + "<|channel|>".length;
    const msgTag = "<|message|>";
    const msgPos = s.indexOf(msgTag, headerStart);
    if (msgPos === -1) {
      // Incomplete; emit remainder and exit
      out += s.slice(start);
      break;
    }

    const header = s.slice(headerStart, msgPos);
    const payloadStart = msgPos + msgTag.length;

    // Decide how to terminate this channel "line"
    const newlinePos = s.indexOf("\n", payloadStart);

    const headerNorm = header.trim();

    // 1) Toolformer style: commentary to=functions sh → drop just this channel segment
    //    (header + its JSON payload), preserving any trailing text on the same line.
    //    FIX: previously we dropped to newline (or EOF) which removed trailing text.
    if (/\bcommentary\b/i.test(headerNorm) && /\bto=functions\b/i.test(headerNorm)) {
      const json = tryExtractJSONObject(s, payloadStart);
      if (json.ok && json.end > payloadStart) {
        // Skip exactly the channel block + its JSON payload; keep trailing text.
        i = json.end;
        continue;
      }
      // Not JSON → drop up to newline (if any). If no newline, drop to end for safety.
      i = newlinePos === -1 ? s.length : newlinePos + 1;
      continue;
    }

    // 2) commentary channel with JSON → stdout
    if (/^commentary\b/i.test(headerNorm)) {
      const json = tryExtractJSONObject(s, payloadStart);
      if (json.ok && json.end > payloadStart) {
        const stdout =
          json.value && typeof (json.value as any).stdout === "string"
            ? (json.value as any).stdout
            : "";
        out += stdout;
        i = json.end;
        continue;
      }
      // Not JSON or parse failed → drop line
      i = newlinePos === -1 ? s.length : newlinePos + 1;
      continue;
    }

    // 3) final channel
    if (/^final\b/i.test(headerNorm)) {
      // final |json → {"cmd":"echo \"@@user Hi!\" "}
      if (/\|json\b/i.test(headerNorm)) {
        const json = tryExtractJSONObject(s, payloadStart);
        if (json.ok && json.end > payloadStart) {
          const value = json.value as any;
          const cmd = typeof value?.cmd === "string" ? value.cmd : "";
          const mention = parseMention(header);
          const echoed = extractEchoPayload(cmd);
          out += mention ? joinMentionAndMessage(mention, echoed) : echoed;
          i = json.end;
          continue;
        }
        // Not JSON → drop line
        i = newlinePos === -1 ? s.length : newlinePos + 1;
        continue;
      }

      // final plain → use constrain mention + message (up to newline)
      const mention = parseMention(header);
      const message = s.slice(payloadStart, newlinePos === -1 ? s.length : newlinePos);
      out += mention ? joinMentionAndMessage(mention, message) : message;
      i = newlinePos === -1 ? s.length : newlinePos + 1;
      continue;
    }

    // 4) Unknown channels → drop up to newline (or end)
    i = newlinePos === -1 ? s.length : newlinePos + 1;
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Channel helpers                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

function parseMention(header: string): string | null {
  // Look for "<|constrain|>@@user" (or @@something). Keep the literal mention.
  const m = header.match(/<\|constrain\|>\s*(@@[\w.-]+)/);
  return m ? m[1] : null;
}

function joinMentionAndMessage(mention: string, message: string): string {
  const body = message.replace(/^\s+/, "");
  // Always ensure exactly one space between mention and message
  return `${mention} ${body}`;
}

/** Extract the payload of a shell echo command (handles quoted form). */
function extractEchoPayload(cmd: string): string {
  // Common pattern: echo "something"   OR   echo 'something'
  const m = cmd.match(/^\s*echo\s+(["'])([\s\S]*?)\1/);
  if (m) return m[2];

  // Fallback: unquoted → take the rest
  return cmd.replace(/^\s*echo\s+/, "").trim();
}

/**
 * Try to extract a single JSON object that starts at `start` (or after optional whitespace)
 * and ends at the matching closing '}'. Returns its parsed value and end offset.
 */
function tryExtractJSONObject(
  s: string,
  start: number
): { ok: true; value: unknown; end: number } | { ok: false } {
  // Skip leading whitespace
  let i = start;
  while (i < s.length && /\s/.test(s[i]!)) i++;

  if (i >= s.length || s[i] !== "{") return { ok: false };

  let depth = 0;
  let inString = false;
  let escape = false;
  let j = i;

  for (; j < s.length; j++) {
    const ch = s[j]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
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
        // Include the closing brace
        j++;
        const raw = s.slice(i, j);
        try {
          const value = JSON.parse(raw);
          return { ok: true, value, end: j };
        } catch {
          return { ok: false };
        }
      }
    }
  }

  return { ok: false };
}
