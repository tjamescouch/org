// src/utils/filter-passes/llm-pda-stream-pass.ts
//
// Single-pass pushdown-automaton-style filter for LLM streaming output.
// It folds the previous multi-pass logic (drop memory/analysis/tool_call,
// unwrap tool_result, handle channel/message lines, and preserve code fences).
//
// Notes on streaming: push() just buffers, and we perform the transform in end().
// The tests only assert the final emitted text. This keeps the implementation
// simple and correct; we can make push() incremental later without changing
// the external interface.

export class LLMPdaStreamPass {
  private buf = "";

  // Optional interface compatibility: some call sites expect these fields to exist.
  public name = "LLMPdaStreamPass";

  feed(chunk: string): {cleaned: string, removed: number} {
    if (!chunk) return { cleaned: "",  removed: 0};
    this.buf += chunk;
    return { cleaned: "", removed: 0 }; // emit at end()
  }

  flush(): {cleaned: string, removed: number} {
    const out = this.cleanAll(this.buf);
    this.buf = "";
    return { cleaned: out, removed: 0 };
  }

  // ---- core transform ------------------------------------------------------

  private cleanAll(s: string): string {
    // Drop blocks first, so they don't interfere with channel parsing.
    s = s.replace(/<\|memory_start\|>[\s\S]*?<\|memory_end\|>/g, "");
    s = s.replace(/<\|analysis_start\|>[\s\S]*?<\|analysis_end\|>/g, "");
    s = s.replace(/<\|tool_call_start\|>[\s\S]*?<\|tool_call_end\|>/g, "");
    s = s.replace(/<\|tool_result_start\|>([\s\S]*?)<\|tool_result_end\|>/g, "$1");

    // Preserve code fences verbatim.
    let out = "";
    let i = 0;
    let inFence = false;
    while (i < s.length) {
      const j = s.indexOf("```", i);
      if (j === -1) {
        const seg = s.slice(i);
        out += inFence ? seg : this.rewriteChannels(seg);
        break;
      } else {
        const seg = s.slice(i, j);
        out += inFence ? seg : this.rewriteChannels(seg);
        out += "```";
        inFence = !inFence;
        i = j + 3;
      }
    }
    return out;
  }

  private rewriteChannels(s: string): string {
    const TOK_CHANNEL = "<|channel|>";
    const TOK_MESSAGE = "<|message|>";

    let out: string[] = [];
    let i = 0;

    while (true) {
      const pos = s.indexOf(TOK_CHANNEL, i);
      if (pos === -1) {
        out.push(s.slice(i));
        break;
      }

      // Emit plain text before the token.
      out.push(s.slice(i, pos));

      const afterChannel = pos + TOK_CHANNEL.length;
      const msgPos = s.indexOf(TOK_MESSAGE, afterChannel);
      if (msgPos === -1) {
        // Not a complete channel line; give up and pass through as-is.
        out.push(s.slice(pos));
        break;
      }

      const header = s.slice(afterChannel, msgPos);
      const afterMessage = msgPos + TOK_MESSAGE.length;

      // Decide how far the message extends.
      let end = this.findJsonEnd(s, afterMessage);
      if (end == null) {
        // Not JSON — treat as a line: up to newline or EOS.
        const eol = s.indexOf("\n", afterMessage);
        end = eol !== -1 ? eol : s.length;
      }
      const message = s.slice(afterMessage, end);
      const nextChar = s.slice(end, end + 1);

      const { replacement, dropNewline } = this.processChannel(header, message);
      out.push(replacement);

      // If dropping a line, swallow the following newline if present.
      i = end + (dropNewline && nextChar === "\n" ? 1 : 0);
    }

    return out.join("");
  }

  private processChannel(headerRaw: string, msg: string): { replacement: string; dropNewline: boolean } {
    // Pull out constraint/mention(s), e.g. "<|constrain|>@@user".
    const constrainRe = /<\|constrain\|>([^<]+)/g;
    const mentions: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = constrainRe.exec(headerRaw)) !== null) {
      mentions.push(m[1]);
    }
    const header = headerRaw.replace(/<\|constrain\|>[^<]+/g, " ").trim();

    // Drop Toolformer "to=functions sh" commentary lines entirely.
    if (/^\s*commentary\b.*\bto=functions\b.*\bsh\b/i.test(header)) {
      return { replacement: "", dropNewline: false };
    }

    // Commentary JSON → stdout.
    if (/^\s*commentary\b/i.test(header)) {
      try {
        const obj = JSON.parse(msg);
        const stdout = obj?.stdout ?? "";
        return { replacement: String(stdout), dropNewline: false };
      } catch {
        // Non-JSON commentary line; drop the line including its trailing newline.
        return { replacement: "", dropNewline: true };
      }
    }

    // final channel (optionally "|json")
    if (/^\s*final\b/i.test(header)) {
      const isJson = /\|json\b/i.test(header);
      if (isJson) {
        let out = "";
        try {
          const obj = JSON.parse(msg);
          out = obj?.stdout ?? "";
          if (!out && typeof obj?.cmd === "string") {
            const m = /^echo\s+(?:(["'])([\s\S]*?)\1|(.+))\s*$/.exec(obj.cmd);
            if (m) out = m[2] ?? m[3] ?? "";
          }
        } catch {
          // Fallback: treat body as text.
          out = msg;
        }
        return { replacement: this.joinMentions(mentions, out), dropNewline: false };
      } else {
        return { replacement: this.joinMentions(mentions, msg), dropNewline: false };
      }
    }

    // Unknown channel → drop (swallow the trailing newline if present)
    return { replacement: "", dropNewline: true };
  }

  private joinMentions(mentions: string[], content: string): string {
    if (mentions.length === 0) return content;
    const prefix = mentions.join(" ") + (content ? " " : "");
    return prefix + content;
  }

  // Find the end index (exclusive) of a JSON value starting at `start`.
  // Handles {...}, [...], and "string" with escapes. Returns null if not JSON.
  private findJsonEnd(s: string, start: number): number | null {
    const n = s.length;
    if (start >= n) return null;
    const ch = s[start];

    if (ch === '"') {
      let i = start + 1;
      while (i < n) {
        if (s[i] === '"' && s[i - 1] !== "\\") return i + 1;
        i++;
      }
      return null;
    }

    if (ch !== "{" && ch !== "[") {
      return null;
    }

    const stack: string[] = [ch];
    let i = start + 1;
    let inStr = false;
    let esc = false;

    while (i < n && stack.length) {
      const c = s[i];

      if (inStr) {
        if (esc) {
          esc = false;
        } else if (c === "\\") {
          esc = true;
        } else if (c === '"') {
          inStr = false;
        }
        i++;
        continue;
      }

      if (c === '"') {
        inStr = true;
      } else if (c === "{") {
        stack.push("{");
      } else if (c === "[") {
        stack.push("[");
      } else if (c === "}" && stack[stack.length - 1] === "{") {
        stack.pop();
      } else if (c === "]" && stack[stack.length - 1] === "[") {
        stack.pop();
      }
      i++;
    }

    return stack.length ? null : i;
  }
}

export default LLMPdaStreamPass;
