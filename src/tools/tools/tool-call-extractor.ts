import type { ToolCall } from "../../types";

export function extractToolCallsFromText(input: string): { tool_calls: ToolCall[]; cleaned: string } {
  const text = String(input);
  let out = "";
  let i = 0;
  const calls: ToolCall[] = [];

  while (i < text.length) {
    const k = text.indexOf('"tool_calls"', i);
    if (k === -1) { out += text.slice(i); break; }

    // copy bytes before this occurrence
    // Copy bytes before this occurrence.  If the prefix consists solely of
    // an opening brace (e.g. "{"), drop it so that the matching closing
    // brace can be removed later.
    const prefix = text.slice(i, k);
    if (prefix.trim() === "{") {
      // do not append the opening brace
    } else {
      out += prefix;
    }
    let j = k + '"tool_calls"'.length;

    // skip spaces and colon
    while (j < text.length && /\s/.test(text[j] ?? '')) j++;
    if (text[j] !== ":") { // not a key-value pair; copy and continue
      out += text.slice(k, j + 1);
      i = j + 1;
      continue;
    }
    j++; // skip ':'
    while (j < text.length && /\s/.test(text[j] ?? '')) j++;

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
          // Validate the shape of each potential tool call.  We only accept
          // objects that specify type="function" and have a function with a
          // string name.  Arguments may be a string or any other JSON value.
          if (x && x.type === "function" && x.function && typeof x.function.name === "string") {
            // Normalize arguments: if already a string, use as-is; otherwise
            // stringify the value.  This preserves original quotes when the
            // argument is already a JSON string.
            const args = typeof x.function.arguments === "string"
              ? x.function.arguments
              : JSON.stringify(x.function.arguments ?? "");
            calls.push({
              id: typeof x.id === "string" ? x.id : "",
              name: x.function.name,
              arguments: args,
            });
          }
        }
      }
      // remove the whole `"tool_calls": [ ... ]` segment from output
      // also swallow any trailing whitespace.  If a closing brace immediately
      // follows the array, skip it as well; we dropped its matching opening
      // brace earlier.
      i = j;
      while (i < text.length && /\s/.test(text[i] ?? '')) i++;
      if (i < text.length && text[i] === '}') {
        i++;
        while (i < text.length && /\s/.test(text[i] ?? '')) i++;
      }
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