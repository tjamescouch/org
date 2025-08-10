import { ToolCall } from './chat'

export function extractToolCallsFromText(input: string): { tool_calls: ToolCall[]; cleaned: string } {
  const text = String(input);
  let out = "";
  let i = 0;
  const calls: ToolCall[] = [];

  while (i < text.length) {
    const k = text.indexOf('"tool_calls"', i);
    if (k === -1) { out += text.slice(i); break; }

    // copy bytes before this occurrence
    out += text.slice(i, k);
    let j = k + '"tool_calls"'.length;

    // skip spaces and colon
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== ":") { // not a key-value pair; copy and continue
      out += text.slice(k, j + 1);
      i = j + 1;
      continue;
    }
    j++; // skip ':'
    while (j < text.length && /\s/.test(text[j])) j++;

    // must be an array
    if (text[j] !== "[") {
      // not the pattern we want; emit as-is and continue
      out += text.slice(k, j + 1);
      i = j + 1;
      continue;
    }

    // bracket-balance the array ONLY
    let arrStart = j;
    let depth = 0, inStr = false, esc = false;
    let arrEnd = -1;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "[") { depth++; continue; }
      if (ch === "]") {
        depth--;
        if (depth === 0) { arrEnd = j; j++; break; }
      }
    }
    if (arrEnd === -1) {
      // malformed; emit remainder and stop
      out += text.slice(k);
      i = text.length;
      break;
    }

    const arrayText = text.slice(arrStart, arrEnd + 1);

    // Try parse just the array; filter to valid tool-call shapes
    try {
      const parsed = JSON.parse(arrayText);
      if (Array.isArray(parsed)) {
        for (const x of parsed) {
          if (x && x.type === "function" && x.function && typeof x.function.name === "string") {
            // normalize arguments to string
            const args = typeof x.function.arguments === "string"
              ? x.function.arguments
              : JSON.stringify(x.function.arguments ?? "");
            calls.push({
              id: typeof x.id === "string" ? x.id : "",
              index: typeof x.index === "number" ? x.index : undefined,
              type: "function",
              function: { name: x.function.name, arguments: args },
            });
          }
        }
      }
      // remove the whole `"tool_calls": [ ... ]` segment from output
      // also swallow any trailing whitespace
      i = j;
      while (i < text.length && /\s/.test(text[i])) i++;
      continue;
    } catch {
      // if parsing fails, keep original bytes and move on
      out += text.slice(k, j);
      i = j;
      continue;
    }
  }

  return { tool_calls: calls, cleaned: out.trim() };
}