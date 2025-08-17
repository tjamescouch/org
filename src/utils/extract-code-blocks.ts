export interface CodeBlock {
  /** 0-based order of occurrence */
  index: number;
  /** language from the fence info string (lower-cased), or "plain" */
  type: string;
  /** code content with common indentation removed and outer blank lines trimmed */
  cleaned: string;
}

export interface ExtractResult {
  cleaned: string;
  blocks: CodeBlock[];
}

/**
 * Extract fenced code blocks (```lang ... ``` or ~~~lang ... ~~~) from text.
 * - Supports inline (single-line) and multi-line fences.
 * - Language is first token after the opening fence; normalized to lower-case.
 * - Replaces each fenced block in the "cleaned" text by just the code content,
 *   inserting a newline before it when needed.
 */
export function extractCodeGuards(textInput: string): ExtractResult {
  const src = String(textInput ?? "");

  const blocks: CodeBlock[] = [];
  let cleanedOut = "";
  let lastConsumed = 0;

  /** Return a fence descriptor at position `pos`, or null if not a fence. */
  function fenceAt(pos: number): { ch: "`" | "~"; len: number } | null {
    const ch = src[pos];
    if (ch !== "`" && ch !== "~") return null;
    let n = 1;
    while (pos + n < src.length && src[pos + n] === ch) n++;
    if (n >= 3) return { ch: ch as "`" | "~", len: n };
    return null;
  }

  /** Find the matching closing fence of given char/length, starting at `from`. */
  function findClosing(from: number, ch: "`" | "~", len: number): { start: number; end: number } | null {
    let i = from;
    while (i < src.length) {
      if (src[i] === ch) {
        let k = i;
        let n = 0;
        while (k < src.length && src[k] === ch) { n++; k++; }
        if (n >= len) return { start: i, end: k };
        i = k; // skip contiguous run
      } else {
        i++;
      }
    }
    return null;
  }

  /** Dedent while preserving relative indentation; trim outer blank lines. */
  function dedentPreserve(s: string): string {
    const lines = s.replace(/\r\n/g, "\n").split("\n");

    // Drop blank first/last lines (common for fenced blocks)
    while (lines.length && lines[0].trim() === "") lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

    // Compute minimum indent among non-empty lines
    let min = Infinity;
    for (const ln of lines) {
      if (ln.trim() === "") continue;
      const m = ln.match(/^(\s+)/);
      if (m) min = Math.min(min, m[1].length);
      else { min = 0; break; }
    }
    if (!isFinite(min) || min <= 0) return lines.join("\n");
    const pad = " ".repeat(min);
    return lines.map(l => (l.startsWith(pad) ? l.slice(min) : l)).join("\n");
  }

  let i = 0;
  while (i < src.length) {
    const f = fenceAt(i);
    if (!f) { i++; continue; }

    // Opening fence found
    const infoStart = i + f.len;

    // Read info string up to the first newline or until text ends
    let infoEnd = infoStart;
    while (infoEnd < src.length && src[infoEnd] !== "\n" && src[infoEnd] !== "\r") infoEnd++;

    const infoRaw = src.slice(infoStart, infoEnd).trim();
    const lang = (infoRaw.split(/\s+/)[0] || "").toLowerCase() || "plain";

    // Determine code start: if newline follows info, skip it; otherwise inline code starts immediately
    let codeStart = infoEnd;
    if (src[codeStart] === "\r" && src[codeStart + 1] === "\n") codeStart += 2;
    else if (src[codeStart] === "\n") codeStart += 1;

    // Find the closing fence
    const closing = findClosing(codeStart, f.ch, f.len);
    if (!closing) {
      // No closing fence — treat opening fence as normal text and continue
      i = infoStart; // skip the fence chars to avoid infinite loop
      continue;
    }

    const codeEnd = closing.start;
    let codeRaw = src.slice(codeStart, codeEnd);
    const codeClean = dedentPreserve(codeRaw);

    // Append preceding text to cleaned output
    cleanedOut += src.slice(lastConsumed, i);

    // Ensure a newline before code if previous char isn't already a newline or beginning
    if (cleanedOut.length > 0 && !/\n$/.test(cleanedOut)) cleanedOut += "\n";
    cleanedOut += codeClean;

    const blockIndex = blocks.length;
    blocks.push({ index: blockIndex, type: lang, cleaned: codeClean });

    // Advance past the closing fence
    lastConsumed = closing.end;
    i = closing.end;
  }

  // Append any trailing text after the last fence
  cleanedOut += src.slice(lastConsumed);

  return { cleaned: cleanedOut, blocks };
}

/* Convenience alias matching your example name "f" */
export const f = extractCodeGuards;
