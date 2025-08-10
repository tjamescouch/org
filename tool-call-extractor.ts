import { ToolCall } from 'chat'

export function extractToolCallsFromText(
  input: string
): { tool_calls: ToolCall[]; cleaned: string } {
  let i = 0;
  let out = input;
  const all: ToolCall[] = [];

  while (true) {
    const k = out.indexOf('"tool_calls"', i);
    if (k === -1) break;

    // find '[' after "tool_calls"
    const lb = out.indexOf("[", k);
    if (lb === -1) break;

    // scan forward to the matching ']'
    let j = lb, depth = 0, inStr = false, esc = false, rb = -1;
    for (; j < out.length; j++) {
      const ch = out[j];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) { rb = j; break; }
      }
    }
    if (rb === -1) { i = k + 12; continue; } // malformed; skip

    const segmentStart = k;
    const segmentEnd = rb + 1; // include closing ']'
    const arrayText = out.slice(lb, segmentEnd);

    try {
      const parsed = JSON.parse(`{"tool_calls":${arrayText}}`) as { tool_calls: ToolCall[] };
      if (Array.isArray(parsed.tool_calls)) {
        all.push(...parsed.tool_calls);
        // remove this segment from text (including the key and optional spaces/colon)
        const keyToArrayStart = out.slice(segmentStart, lb).match(/"tool_calls"\s*:\s*$/)?.[0]?.length ?? (lb - segmentStart);
        const removeFrom = segmentStart;
        const removeTo = segmentEnd;
        out = out.slice(0, removeFrom) + out.slice(removeTo);
        // continue scanning after the removed part
        i = removeFrom;
        continue;
      }
    } catch {
      // fall through; skip this occurrence
    }

    i = rb + 1;
  }


  console.error('\nextractToolCallsFromText', all);

  return { tool_calls: all, cleaned: out.trim() };
}
