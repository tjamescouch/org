// toolcall-parser.ts
// Parse JSON inside ```toolcall ... ``` code fences (tmux/CLI safe, no deps).
// Accepts either a single object or an array of objects per fence.
// Coerces common field names: name|tool|tool_name, arguments|args|parameters|input,
// and function: { name, arguments } (OpenAI-style).
//
// Example fence:
// ```toolcall
// { "tool_name": "search", "arguments": { "query": "mnist" }, "id": "c1" }
// ```
//
// Multiple fences are supported anywhere in the text.

import { ChatToolCall } from "./types";
import { randomUUID as uuid } from 'node:crypto';

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };


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

  /** Return all parsed tool calls from every ```toolcall fence in `text`. */
  parseAll(text: string): ChatToolCall[] {
    const blocks = this.findToolcallFences(text);
    const out: ChatToolCall[] = [];

    blocks.forEach((b, i) => {
      try {
        const value = this.strictJsonParse(b.content.trim());
        if (Array.isArray(value)) {
          value.forEach((v, j) => {
            const call = this.coerceToolCall(v, i, b.start, b.end);
            call.raw = this.stringifyStable(v);
            out.push(call);
          });
        } else {
          const call = this.coerceToolCall(value, i, b.start, b.end);
          call.raw = this.stringifyStable(value);
          out.push(call);
        }
      } catch (e) {
        if (this.throwOnError) {
          if (e instanceof ToolCallParseError) throw e;
          throw new ToolCallParseError(
            "Failed to parse toolcall fence JSON",
            i,
            b.start,
            b.end,
            e
          );
        }
        // else skip malformed fence
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

  private findToolcallFences(text: string): Array<{ content: string; start: number; end: number }> {
    const blocks: Array<{ content: string; start: number; end: number }> = [];
    let i = 0;
    const needle = "```toolcall";

    while (true) {
      const start = text.indexOf(needle, i);
      if (start === -1) break;

      // End of the opening line
      const openLineEnd = text.indexOf("\n", start);
      if (openLineEnd === -1) break; // incomplete block; ignore

      // Find the closing fence that starts at beginning of a line.
      let searchFrom = openLineEnd + 1;
      let close = -1;
      while (true) {
        const pos = text.indexOf("```", searchFrom);
        if (pos === -1) break;
        const atLineStart = pos === 0 || text[pos - 1] === "\n";
        if (atLineStart) {
          close = pos;
          break;
        }
        searchFrom = pos + 1;
      }
      if (close === -1) break; // unmatched; ignore remainder

      const content = text.slice(openLineEnd + 1, close);
      blocks.push({ content, start, end: close + 3 });
      i = close + 3;
    }
    return blocks;
  }

  private strictJsonParse(s: string): unknown {
    // Fast path: standard JSON only (fail fast; caller decides skip/throw).
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
      throw new ToolCallParseError("Toolcall JSON must be an object or array of objects", fenceIndex, start, end);
    }

    // Accept both flat and { function: { name, arguments } } shapes.
    const fn = this.isObject(v.function) ? (v.function as Record<string, unknown>) : undefined;

    const name =
      this.getString(v, "name") ??
      this.getString(v, "tool") ??
      this.getString(v, "tool_name") ??
      (fn ? this.getString(fn, "name") : undefined);

    if (!name || !name.trim()) {
      throw new ToolCallParseError("Missing tool name (name|tool|tool_name|function.name)", fenceIndex, start, end);
    }

    const id =
      this.getString(v, "id") ??
      this.getString(v, "call_id") ??
      (fn ? this.getString(fn, "id") : undefined);

    const argsCandidate =
      (v as Record<string, unknown>)["arguments"] ??
      (v as Record<string, unknown>)["args"] ??
      (v as Record<string, unknown>)["parameters"] ??
      (v as Record<string, unknown>)["input"] ??
      (fn ? fn["arguments"] : undefined);

    // Arguments can be any JSON value; undefined if absent.
    const tc: ChatToolCall = {
      id: id ?? uuid(),
      type: "function",
      function: {
        name: name.trim(),
        arguments: argsCandidate as string
      },
    };

    return tc;
  }

  private asJson(v: unknown): Json | undefined {
    // We trust JSON.parse for structure; just narrow primitives/objects/arrays to Json.
    if (v === undefined) return undefined;
    if (v === null) return null;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v as Json;
    if (Array.isArray(v)) return v.map((e) => this.asJson(e) as Json) as Json;
    if (this.isObject(v)) {
      const out: { [k: string]: Json } = {};
      for (const [k, val] of Object.entries(v)) out[k] = this.asJson(val) as Json;
      return out;
    }
    // Non-JSON (e.g., function, symbol) should not occur from JSON.parse; treat as string.
    return String(v) as unknown as Json;
  }

  private stringifyStable(v: unknown): string {
    return JSON.stringify(v, this.stableReplacer, 2);
  }

  // Stable key order for deterministic raw snapshots.
  private stableReplacer(this: unknown, key: string, value: unknown): unknown {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const sorted = Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (obj as Record<string, unknown>)[k];
          return acc;
        }, {});
      return sorted;
    }
    return value;
  }
}

// Convenience one-liner
export function parseGemmaToolCalls(text: string, opts?: ParserOptions): ChatToolCall[] {
  return new GemmaToolcallParser(opts).parseAll(text);
}
