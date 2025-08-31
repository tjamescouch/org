// src/utils/filter-passes/llm-pda-stream.ts

export type PDAStreamFilter = {
  feed(chunk: string): string;   // returns output ready so far
  flush(): string;               // call at end of stream
};

type Mode =
  | "TEXT"
  | "READ_CHANNEL_HEADER"
  | "READ_CONSTRAIN"
  | "READ_MESSAGE"
  | "DROP_UNTIL"
  | "PASS_UNTIL";

export function makePDAStreamFilter(): PDAStreamFilter {
  let rest = "";            // unconsumed stream buffer
  let pushback = "";        // prepend-on-next-scan buffer
  const out: string[] = []; // pending output
  let mode: Mode = "TEXT";

  // Channel buffers
  let channelHeader = "";
  let mentionBuf = "";
  let messageBuf = "";

  // Region controls
  let untilTag: string | null = null;

  // Toolformer JSON drop state
  let toolformerJSON = false;
  let jsonDepth = 0;
  let inString = false;
  let escape = false;

  const emit = (s: string) => { if (s) out.push(s); };
  const isWhitespaceOnly = (s: string) => /^[\s]*$/.test(s);

  function finalizeChannelIfPossible(force: boolean = false) {
    if (mode !== "READ_MESSAGE") return;

    const nl = messageBuf.indexOf("\n");
    const shouldFinalize = force || nl !== -1;
    if (!shouldFinalize) return;

    const body = nl === -1 ? messageBuf : messageBuf.slice(0, nl);
    const after = nl === -1 ? "" : messageBuf.slice(nl + 1);
    const header = channelHeader.trim();
    const headerLC = header.toLowerCase();
    const isToolformer = headerLC.startsWith("commentary") && /to=functions\b/.test(headerLC);

    if (isToolformer) {
      // drop
    } else if (headerLC === "commentary") {
      try {
        const obj = JSON.parse(body.trim());
        if (obj && typeof obj.stdout === "string") emit(obj.stdout);
      } catch { /* drop */ }
    } else if (headerLC === "final" || headerLC.startsWith("final ")) {
      const isJson = headerLC.includes("|json");
      if (isJson) {
        try {
          const obj = JSON.parse(body.trim());
          if (obj && typeof obj.cmd === "string") {
            let arg = obj.cmd.trim();
            if (arg.toLowerCase().startsWith("echo")) {
              arg = arg.slice(4).trim();
              if ((arg.startsWith('"') && arg.endsWith('"')) ||
                  (arg.startsWith("'") && arg.endsWith("'"))) {
                arg = arg.slice(1, -1);
              }
              emit(arg);
            }
          }
        } catch { /* drop */ }
      } else {
        const mention = mentionBuf.trim();
        const msg = body.trim();
        if (!isWhitespaceOnly(msg)) {
          emit(mention ? `${mention} ${msg}` : msg);
        }
      }
    } else {
      // Unknown channel: drop up to newline (body); keep after
    }

    // reset channel state
    channelHeader = "";
    mentionBuf = "";
    messageBuf = "";
    mode = "TEXT";
    toolformerJSON = false;
    jsonDepth = 0;
    inString = false;
    escape = false;

    if (after) pushback = after + pushback;
  }

  function handleCompleteTag(tag: string) {
    // If we were accumulating a channel message, a new tag ends that line
    if (mode === "READ_MESSAGE") finalizeChannelIfPossible(true);

    switch (tag) {
      // Region drop/passthrough
      case "memory_start":    mode = "DROP_UNTIL"; untilTag = "memory_end"; return;
      case "analysis_start":  mode = "DROP_UNTIL"; untilTag = "analysis_end"; return;
      case "tool_call_start": mode = "DROP_UNTIL"; untilTag = "tool_call_end"; return;
      case "tool_result_start": mode = "PASS_UNTIL"; untilTag = "tool_result_end"; return;

      // Final block unwrap
      case "final_start":     mode = "PASS_UNTIL"; untilTag = "final_end"; return;

      // Channel line
      case "channel":
        if (mode !== "DROP_UNTIL" && mode !== "PASS_UNTIL") {
          mode = "READ_CHANNEL_HEADER";
          channelHeader = ""; mentionBuf = ""; messageBuf = "";
        }
        return;

      case "constrain":
        if (mode === "READ_CHANNEL_HEADER") mode = "READ_CONSTRAIN";
        return;

      case "message":
        if (mode === "READ_CHANNEL_HEADER" || mode === "READ_CONSTRAIN") {
          mode = "READ_MESSAGE";
          // Toolformer: commentary to=functions sh → drop one balanced JSON object only
          if (channelHeader.trim().toLowerCase().startsWith("commentary") &&
              /to=functions\b/.test(channelHeader.toLowerCase())) {
            toolformerJSON = true;
            jsonDepth = 0; inString = false; escape = false;
          }
        }
        return;

      default:
        // Unknown tag: treat as literal (put it back to rest so it passes through)
        rest = `<|${tag}|>` + rest;
        mode = "TEXT";
        return;
    }
  }

  function consumeText(text: string) {
    if (!text) return;

    if (mode === "TEXT") { emit(text); return; }
    if (mode === "READ_CHANNEL_HEADER") { channelHeader += text; return; }
    if (mode === "READ_CONSTRAIN") { mentionBuf += text; return; }

    if (mode === "READ_MESSAGE") {
      if (toolformerJSON) {
        // Scan char-by-char to find the end of the top-level JSON object
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          messageBuf += ch;

          if (inString) {
            if (escape) { escape = false; }
            else if (ch === "\\") { escape = true; }
            else if (ch === '"') { inString = false; }
          } else {
            if (ch === '"') inString = true;
            else if (ch === "{") jsonDepth++;
            else if (ch === "}") {
              jsonDepth--;
              if (jsonDepth === 0) {
                // Completed the JSON object => finalize now
                const remainder = text.slice(i + 1);
                finalizeChannelIfPossible(true);
                if (remainder) pushback = remainder + pushback;
                return; // done with this chunk
              }
            }
          }
        }
      } else {
        messageBuf += text;
        if (text.includes("\n")) finalizeChannelIfPossible(false);
      }
      return;
    }

    if (mode === "DROP_UNTIL") return;
    if (mode === "PASS_UNTIL") { emit(text); return; }
  }

  function scanOnce(): boolean {
    // If there's pushback, prepend it first
    if (pushback) { rest = pushback + rest; pushback = ""; }

    // Inside DROP/PASS regions we look only for the specific closing tag
    if (mode === "DROP_UNTIL" || mode === "PASS_UNTIL") {
      const close = untilTag!;
      const pat = `<|${close}|>`;
      const idx = rest.indexOf(pat);
      if (idx === -1) {
        // Keep a tail so a split closing tag isn’t lost across chunks
        const tail = Math.max(1, pat.length - 1);
        if (mode === "PASS_UNTIL") emit(rest.slice(0, -Math.min(rest.length, tail)));
        rest = rest.slice(-Math.min(rest.length, tail));
        return false;
      }
      if (mode === "PASS_UNTIL") emit(rest.slice(0, idx));
      rest = rest.slice(idx + pat.length);
      mode = "TEXT"; untilTag = null;
      return true;
    }

    // General tag scanning
    const i = rest.indexOf("<|");
    if (i === -1) {
      // No opener: consume text, but preserve trailing '<' (could be start of tag)
      if (rest.endsWith("<")) {
        consumeText(rest.slice(0, -1));
        rest = "<";
      } else {
        consumeText(rest);
        rest = "";
      }
      return false;
    }

    const j = rest.indexOf("|>", i + 2);
    if (j === -1) {
      // Incomplete tag; consume prefix, keep '<|' for next chunk
      consumeText(rest.slice(0, i));
      rest = rest.slice(i);
      return false;
    }

    // We have a complete tag
    consumeText(rest.slice(0, i));
    const tagName = rest.slice(i + 2, j);
    rest = rest.slice(j + 2);
    handleCompleteTag(tagName);
    return true;
  }

  function feed(chunk: string): string {
    if (!chunk) return "";
    rest += chunk;
    while (scanOnce()) { /*loop*/ }
    const s = out.join("");
    out.length = 0;
    return s;
  }

  function flush(): string {
    // Pull any pushback into rest and finish up
    if (pushback) { rest = pushback + rest; pushback = ""; }

    if (mode === "DROP_UNTIL") {
      rest = ""; mode = "TEXT"; untilTag = null;
    } else if (mode === "PASS_UNTIL") {
      emit(rest); rest = ""; mode = "TEXT"; untilTag = null;
    } else if (mode === "READ_MESSAGE") {
      finalizeChannelIfPossible(true);
    } else {
      if (rest.endsWith("<")) { consumeText(rest.slice(0, -1)); rest = "<"; }
      consumeText(rest);
      rest = "";
    }

    const s = out.join("");
    out.length = 0;
    return s;
  }

  return { feed, flush };
}

// Handy helper used by tests
export function runAtChunkSize(s: string, n: number): string {
  const f = makePDAStreamFilter();
  let out = "";
  for (let i = 0; i < s.length; i += n) out += f.feed(s.slice(i, i + n));
  out += f.flush();
  return out;
}
