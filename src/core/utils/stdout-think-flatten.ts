// Streaming CoT (Chain-of-Thought) flattener for stdout.
//
// Goal: collapse blocks like
//   **** alice @ 3:01:00 AM:
//   We
//   need
//   to
//   respond
//   ...
//   Simple
//   .
// into a single line before the visible assistant content, while *not*
// touching normal logs. We do this by buffering stdout and rewriting the
// "think prelude" just before the first "assistant:" marker.
//
// Safe: if anything looks wrong, we simply passthrough the original text.

const ANSI = /\x1B\[[0-9;]*m/g;

// Very tolerant single-pass flattener for a think prelude sitting between
// the speaker header and the first 'assistant:' marker.
export function flattenThinkBlockOnce(haystack: string): [string, boolean] {
  // Locate the start header line: "**** name @ time:\n"
  const start = haystack.lastIndexOf("**** ");
  if (start < 0) return [haystack, false];

  // We only rewrite if we also have an 'assistant:' *after* start.
  const assistantIdx = haystack.indexOf("assistant:", start);
  if (assistantIdx < 0) return [haystack, false];

  // Find the end of the header (newline after the colon)
  const headerEnd = haystack.indexOf("\n", start);
  if (headerEnd < 0 || headerEnd > assistantIdx) return [haystack, false];

  const header = haystack.slice(start, headerEnd + 1);
  const body = haystack.slice(headerEnd + 1, assistantIdx);

  // If body already looks flat (one line), bail.
  if (!/\n[^\n]/.test(body)) return [haystack, false];

  // Strip ANSI, split, trim and join with single spaces.
  const flattened = body
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .join(" ");

  const rewritten = haystack.slice(0, start) + header + flattened + "\n" + haystack.slice(assistantIdx);
  return [rewritten, true];
}

export function installStdoutThinkFlatten(): void {
  const enabled = process.env.SHOW_THINK === "1";
  if (!enabled) return;

  // Don't double-install
  if ((process.stdout as any).__orgThinkFlattenInstalled) return;
  (process.stdout as any).__orgThinkFlattenInstalled = true;

  const origWrite = process.stdout.write.bind(process.stdout);
  let buf = "";

  function flush(force = false) {
    // Try to rewrite once; if rewritten, try again in case of cascades.
    let changed = false, tries = 0;
    do {
      tries++;
      let rewritten; [rewritten, changed] = flattenThinkBlockOnce(buf);
      if (changed) buf = rewritten;
    } while (changed && tries < 3);

    // Heuristic: flush whenever we end a line, or buffer is getting big,
    // or we're forced.
    if (force || /\n$/.test(buf) || buf.length > 16384) {
      if (buf) {
        origWrite(buf);
        buf = "";
      }
    }
  }

  (process.stdout as any).write = function(chunk: any, enc?: any, cb?: any) {
    try {
      const s = typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk) ? chunk.toString(enc || "utf8")
        : String(chunk);

      buf += s;
      flush(false);
      if (typeof cb === "function") cb();
      return true;
    } catch (e) {
      // Be conservative – on error, fall back to original.
      return origWrite(chunk, enc, cb);
    }
  };

  // Ensure we flush at exit
  process.on("beforeExit", () => flush(true));
}
