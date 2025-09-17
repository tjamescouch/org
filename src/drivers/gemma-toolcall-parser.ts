// toolcall-parser.ts
// Parse tool calls emitted as:
//   1) ```toolcall … ```   (and tool_request|tool_call|tool)   ← backtick fences
//   2) [TOOL_REQUEST] … [END_TOOL_REQUEST]                     ← bracket blocks
//   3) Mixed: ```tool_request … [END_TOOL_REQUEST]
// Strict JSON inside; no “fixups”.

import { ChatToolCall } from "./types";
import { randomUUID as uuid } from "node:crypto";

export class ToolCallParseError extends Error {
  constructor(
    message: string,
    public readonly fenceIndex: number,
    public readonly start: number,
    public readonly end: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ToolCallParseError";
  }
}

export interface ParserOptions {
  /** If true, throw on the first malformed fence; otherwise skip bad fences. Default: false. */
  throwOnError?: boolean;
}

export class GemmaToolcallParser {
  private readonly throwOnError: boolean;

  constructor(opts: ParserOptions = {}) {
    this.throwOnError = !!opts.throwOnError;
  }

  /** Return all parsed tool calls from every supported block in `text`. */
  parseAll(text: string): ChatToolCall[] {
    const blocks = this.findToolcallBlocks(text);
    const out: ChatToolCall[] = [];

    blocks.forEach((b, i) => {
      try {
        const value = this.strictJsonParse(b.content.trim());
        if (Array.isArray(value)) {
          for (const v of value) out.push(this.coerceToolCall(v, i, b.start, b.end));
        } else {
          out.push(this.coerceToolCall(value, i, b.start, b.end));
        }
      } catch (e) {
        if (this.throwOnError) {
          if (e instanceof ToolCallParseError) throw e;
          throw new ToolCallParseError("Failed to parse toolcall block JSON", i, b.start, b.end, e);
        }
        // skip malformed block
      }
    });

    return out;
  }

  /** Return the first tool call found or null. */
  parseFirst(text: string): ChatToolCall | null {
    const all = this.parseAll(text);
    return all.length ? all[0] : null;
  }

  // ---------- internals ----------

  private strictJsonParse(s: string): unknown {
    return JSON.parse(s) as unknown;
  }

  private isObject(x: unknown): x is Record<string, unknown> {
    return typeof x === "object" && x !== null && !Array.isArray(x);
  }

  private getString(o: Record<string, unknown>, key: string): string | undefined {
    const v = o[key];
    return typeof v === "string" ? v : undefined;
  }

  private coerceToolCall(
    v: unknown,
    fenceIndex: number,
    start: number,
    end: number
  ): ChatToolCall {
    if (!this.isObject(v)) {
      throw new ToolCallParseError(
        "Toolcall JSON must be an object or array of objects",
        fenceIndex,
        start,
        end
      );
    }

    // Support both flat and OpenAI-style { function: { name, arguments } }.
    const fnObj = this.isObject((v as Record<string, unknown>)["function"])
      ? ((v as Record<string, unknown>)["function"] as Record<string, unknown>)
      : undefined;

    const name =
      this.getString(v, "name") ??
      this.getString(v, "tool") ??
      this.getString(v, "tool_name") ??
      (fnObj ? this.getString(fnObj, "name") : undefined);

    if (!name || !name.trim()) {
      throw new ToolCallParseError(
        "Missing tool name (name|tool|tool_name|function.name)",
        fenceIndex,
        start,
        end
      );
    }

    const id =
      this.getString(v, "id") ??
      this.getString(v, "call_id") ??
      (fnObj ? this.getString(fnObj, "id") : undefined) ??
      uuid();

    // Prefer top-level arguments, then function.arguments. Serialize to JSON string.
    const argsCandidate =
      (v as Record<string, unknown>)["arguments"] ??
      (v as Record<string, unknown>)["args"] ??
      (v as Record<string, unknown>)["parameters"] ??
      (v as Record<string, unknown>)["input"] ??
      (fnObj ? fnObj["arguments"] : undefined);

    const argsString =
      typeof argsCandidate === "string"
        ? argsCandidate
        : this.stringifyStable(argsCandidate ?? {});

    const tc: ChatToolCall = {
      id,
      type: "function",
      function: {
        name: name.trim(),
        arguments: argsString,
      },
    };

    return tc;
  }

  private stringifyStable(v: unknown): string {
    return JSON.stringify(v, (key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const sorted = Object.keys(obj)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = obj[k];
            return acc;
          }, {});
        return sorted;
      }
      return value;
    });
  }

  // ----- block detection supporting multiple syntaxes -----

  private findToolcallBlocks(
    text: string
  ): Array<{ content: string; start: number; end: number }> {
    const blocks: Array<{ content: string; start: number; end: number }> = [];

    // Openers at line start (case-insensitive):
    //   ```tool_request]   or ```tool_request
    //   ```tool_call|toolcall|tool
    //   [TOOL_REQUEST]  (also TOOL_CALL/TOOL)
    const openRe =
      /^(?:```[ \t]*(toolcall|tool_request|tool_call|tool)\]?[^\n]*\n|\[(tool_request|tool_call|tool)\][ \t]*\r?\n)/gim;

    let m: RegExpExecArray | null;
    while ((m = openRe.exec(text))) {
      const openStart = m.index;
      const contentStart = openRe.lastIndex;
      const label = (m[1] ? m[1] : m[2] ? m[2] : "tool_request").toString();

      const rest = text.slice(contentStart);

      // Closers (earliest wins):
      //   1) line with ``` alone
      //   2) line with [END_<LABEL>] or [/LABEL]  (case-insensitive)
      const closeBacktick = this.execFirst(rest, /^```[ \t]*$/gim);
      const labelUpper = label.toUpperCase().replace(/\]$/, "");
      const endTagRe = new RegExp(
        String.raw`^\[(?:END_|\/)${this.escapeRe(labelUpper)}\][ \t]*$`,
        "gim"
      );
      // Fallback: any [END_*] tag
      const endAnyRe = /^\[(?:END_|\/)[A-Z0-9_]+\][ \t]*$/gim;

      const closeBracketSpecific = this.execFirst(rest, endTagRe);
      const closeBracketAny = this.execFirst(rest, endAnyRe);

      const candidates = [closeBacktick, closeBracketSpecific, closeBracketAny]
        .filter(Boolean)
        .sort((a, b) => (a!.index < b!.index ? -1 : 1)) as Array<{
        index: number;
        match: string;
      }>;

      if (!candidates.length) break; // unmatched; stop scanning

      const chosen = candidates[0];
      const content = rest.slice(0, chosen.index);
      const end = contentStart + chosen.index + chosen.match.length;

      blocks.push({ content, start: openStart, end });

      // Continue scanning after this block
      openRe.lastIndex = end;
    }

    return blocks;
  }

  private execFirst(
    s: string,
    re: RegExp
  ): { index: number; match: string } | null {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = r.exec(s))) return { index: m.index, match: m[0] };
    return null;
  }

  private escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
