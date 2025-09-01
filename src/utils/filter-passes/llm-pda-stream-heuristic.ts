/**
 * PDA stream filter — streaming + safe-prefix commit
 *
 * Goals (as exercised by tests):
 * - Channel lines:
 *   - <|channel|>final <|constrain|>@@user<|message|>Hello!  → "@@user Hello!"
 *   - <|channel|>final |json<|message|>{"cmd":"echo \"@@user Hi!\" "} → "@@user Hi!"
 *   - <|channel|>commentary<|message|>{"ok":true,"stdout":"@@user Done."} → "@@user Done."
 *   - <|channel|>commentary to=functions sh<|message|>{"cmd":1} → drop header+JSON only (preserve trailing text)
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
 * Streaming design:
 *   - feed(chunk) appends to a buffer, finds the largest "safe" prefix that
 *     doesn't split across a structure that would change with more bytes
 *     (channels, JSON, paired blocks, final wrappers), and immediately emits
 *     the transformed result for that prefix.
 *   - flush() transforms whatever remains (even if incomplete) and clears.
 */

type StreamFilter = {
  /** Supply a chunk of data; returns output that is safe to emit now. */
  feed: (chunk: string) => string;
  /** Finish the stream and return the final transformed output. */
  flush: () => string;
};

/** Public: create a streaming PDA filter */
export function createPDAStreamFilterHeuristic(): StreamFilter {
  let buffer = "";
  // Track whether buffer[0] is at a logical start-of-line (for ``` detection).
  // Initially, we assume start-of-stream == start-of-line.
  let atLineStart = true;

  return {
    feed(chunk: string) {
      buffer += chunk;

      let produced = "";
      while (buffer.length) {
        const commitLen = computeSafeCommitLen(buffer, atLineStart);
        if (commitLen <= 0) break;

        const piece = buffer.slice(0, commitLen);
        produced += filterPDAText(piece);

        // Maintain start-of-line flag for the next unprocessed byte.
        atLineStart = endsWithNewline(piece);
        buffer = buffer.slice(commitLen);
      }

      return produced;
    },
    flush() {
      const out = filterPDAText(buffer);
      buffer = "";
      atLineStart = true;
      return out;
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure transformer (unchanged behavior, proven by tests)                    */
/* ────────────────────────────────────────────────────────────────────────── */

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
/* Streaming helper: compute largest safe prefix                              */
/* ────────────────────────────────────────────────────────────────────────── */

function computeSafeCommitLen(s: string, atLineStart: boolean): number {
  // We walk the string and ensure we don't cut across any structure that would
  // be transformed if we waited. Anything complete is safe to commit.
  let i = 0;
  const N = s.length;

  while (i < N) {
    // 1) Fenced code block start at a line start: ```...
    if (isFenceOpenAt(s, i, atLineStart)) {
      // Find closing fence. If not found yet, the rest is safely commit-able:
      // the pure transformer treats the remainder as a fence and preserves it.
      const close = findBacktickFenceEnd(s, i + 3);
      if (close === -1) return N; // commit all; preserve verbatim
      // Skip the entire fence (open and close markers included)
      i = close + 3;
      atLineStart = isLineStartAt(s, i);
      continue;
    }

    // 2) Channel line
    if (s.startsWith("<|channel|>", i)) {
      const headerStart = i + "<|channel|>".length;
      const msgPos = s.indexOf("<|message|>", headerStart);
      if (msgPos === -1) return i; // incomplete header; wait for more

      const header = s.slice(headerStart, msgPos);
      const payloadStart = msgPos + "<|message|>".length;
      const headerNorm = header.trim();

      // commentary to=functions ... JSON → drop header+JSON only (keep trailing text)
      if (/\bcommentary\b/i.test(headerNorm) && /\bto=functions\b/i.test(headerNorm)) {
        const end = findJsonObjectEnd(s, payloadStart);
        if (end === -1) return i; // need the full JSON
        // Safe to include just past the JSON object; trailing text (if any)
        // will be scanned next loop.
        i = end;
        atLineStart = isLineStartAt(s, i);
        continue;
      }

      // commentary JSON → stdout
      if (/^commentary\b/i.test(headerNorm)) {
        const end = findJsonObjectEnd(s, payloadStart);
        if (end === -1) return i; // need complete JSON
        i = end;
        atLineStart = isLineStartAt(s, i);
        continue;
      }

      // final channel
      if (/^final\b/i.test(headerNorm)) {
        // final |json → JSON echo unwrap
        if (/\|json\b/i.test(headerNorm)) {
          const end = findJsonObjectEnd(s, payloadStart);
          if (end === -1) return i; // need complete JSON object
          i = end;
          atLineStart = isLineStartAt(s, i);
          continue;
        }
        // final (plain) → require newline to know end of "line"
        const nl = s.indexOf("\n", payloadStart);
        if (nl === -1) return i; // wait for newline (or flush)
        i = nl + 1; // include newline in the safe prefix
        atLineStart = true;
        continue;
      }

      // Unknown channel → drop up to newline
      const nl = s.indexOf("\n", payloadStart);
      if (nl === -1) return i; // need the newline boundary
      i = nl + 1;
      atLineStart = true;
      continue;
    }

    // 3) Paired blocks that must be whole to transform (strip/unwrap)
    const pairedStart =
      startsAt(s, i, "<|memory_start|>") ? "<|memory_start|>" :
      startsAt(s, i, "<|analysis_start|>") ? "<|analysis_start|>" :
      startsAt(s, i, "<|tool_call_start|>") ? "<|tool_call_start|>" :
      startsAt(s, i, "<|tool_result_start|>") ? "<|tool_result_start|>" :
      startsAt(s, i, "<|final_start|>") ? "<|final_start|>" :
      null;

    if (pairedStart) {
      const endTag =
        pairedStart === "<|memory_start|>" ? "<|memory_end|>" :
        pairedStart === "<|analysis_start|>" ? "<|analysis_end|>" :
        pairedStart === "<|tool_call_start|>" ? "<|tool_call_end|>" :
        pairedStart === "<|tool_result_start|>" ? "<|tool_result_end|>" :
        /* "<|final_start|>" */              "<|final_end|>";

      const end = s.indexOf(endTag, i + pairedStart.length);
      if (end === -1) return i; // don't cut through an unfinished pair
      i = end + endTag.length;
      atLineStart = isLineStartAt(s, i);
      continue;
    }

    // No special marker here; step forward.
    atLineStart = s.charCodeAt(i) === 10 /* '\n' */;
    i++;
  }

  return N;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Fence handling helpers                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

type FencePart =
  | { type: "text"; content: string }
  | { type: "fence"; content: string };

/**
 * Split into alternating text/fence parts where fences are triple backtick
 * blocks starting at a line start, and ending at a matching line-start triple
 * backtick. Fence parts are preserved verbatim.
 */
function splitByBacktickFences(s: string): FencePart[] {
  const parts: FencePart[] = [];
  let i = 0;

  // Track line-start status at s[i].
  let atLineStart = true;

  while (i < s.length) {
    const start = findBacktickFenceStart(s, i, atLineStart);
    if (start === -1) {
      parts.push({ type: "text", content: s.slice(i) });
      break;
    }
    if (start > i) {
      parts.push({ type: "text", content: s.slice(i, start) });
    }
    const close = findBacktickFenceEnd(s, start + 3);
    const end = close === -1 ? s.length : close + 3; // include closing ```
    parts.push({ type: "fence", content: s.slice(start, end) });

    // Update line-start at next i
    i = end;
    atLineStart = isLineStartAt(s, i);
    if (close === -1) break;
  }

  return parts;
}

function findBacktickFenceStart(s: string, from: number, atLineStart: boolean): number {
  // find first "```" that is at a line start (either from==0 && atLineStart, or previous char = \n)
  let idx = s.indexOf("```", from);
  while (idx !== -1) {
    if ((idx === from && (from === 0 ? atLineStart : s.charCodeAt(idx - 1) === 10)) ||
        (idx > from && s.charCodeAt(idx - 1) === 10)) {
      return idx;
    }
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

function isFenceOpenAt(s: string, i: number, atLineStart: boolean): boolean {
  if (i + 3 > s.length) return false;
  if (s.charCodeAt(i) !== 96 || s.charCodeAt(i + 1) !== 96 || s.charCodeAt(i + 2) !== 96) return false; // ```
  // Must be at line start
  return (i === 0 ? atLineStart : s.charCodeAt(i - 1) === 10);
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
/* Channel line handling (pure)                                              */
/* ────────────────────────────────────────────────────────────────────────── */

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
    const newlinePos = s.indexOf("\n", payloadStart);
    const headerNorm = header.trim();

    // 1) Toolformer style: commentary to=functions sh → drop header+JSON only
    if (/\bcommentary\b/i.test(headerNorm) && /\bto=functions\b/i.test(headerNorm)) {
      const json = tryExtractJSONObject(s, payloadStart);
      if (json.ok && json.end > payloadStart) {
        // Skip exactly the channel block + its JSON payload; keep trailing text.
        i = json.end;
        continue;
      }
      // Not JSON → drop up to newline (if any). If no newline, drop to end.
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
  const end = findJsonObjectEnd(s, start);
  if (end === -1) return { ok: false };
  try {
    // Parse from the first '{' we actually consumed
    let i = start;
    while (i < s.length && /\s/.test(s[i]!)) i++;
    const raw = s.slice(i, end);
    const value = JSON.parse(raw);
    return { ok: true, value, end };
  } catch {
    return { ok: false };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Low-level scanners                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

function startsAt(s: string, i: number, token: string): boolean {
  return s.startsWith(token, i);
}

function isLineStartAt(s: string, i: number): boolean {
  if (i <= 0) return true;
  return s.charCodeAt(i - 1) === 10 /* '\n' */;
}

function endsWithNewline(s: string): boolean {
  if (!s) return false;
  return s.charCodeAt(s.length - 1) === 10 /* '\n' */;
}

/**
 * Finds the end index (position *after* the closing brace) of a single JSON
 * object that starts at or after `from` (skipping whitespace). Returns -1 if
 * incomplete.
 */
function findJsonObjectEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  if (i >= s.length || s[i] !== "{") return -1;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (; i < s.length; i++) {
    const ch = s[i]!;
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
        return i + 1; // end position is after the closing brace
      }
      continue;
    }
  }

  return -1; // incomplete
}
