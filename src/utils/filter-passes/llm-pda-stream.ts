/* src/utils/filter-passes/llm-pda-stream.ts */

import { LLMNoiseFilterPass } from "./llm-noise-filter-pass";

/** Utility: ensure exactly one space between a mention tag and the message body. */
function joinTagAndMessage(tag: string, body: string): string {
  if (!tag) return body;
  // Only normalize space for mention-like tags (starts with @ or @@).
  if (tag.startsWith('@@') || tag.startsWith('@')) {
    if (body.length === 0) return tag;
    // Insert exactly one space if body doesn't already start with whitespace.
    const needsSpace = !/^\s/.test(body);
    return tag + (needsSpace ? ' ' : '') + body;
  }
  // Non-mention metadata: concatenate as-is.
  return tag + body;
}

type Chan = 'final' | 'commentary' | 'analysis' | 'tool_call' | 'tool_result' | 'memory' | 'other';

export class LLMNoisePDAStream implements LLMNoiseFilterPass{
  private buf = '';
  // --- PDA state ---
  private stack: Array<{ kind: Chan; startTok?: string }> = [];

  // scratch for a single in-flight <|channel|>…<|message|>… block:
  private pendingChannel: Chan | null = null;
  private pendingConstrain = ''; // text between <|constrain|> and <|message|>
  private pendingMessage = '';   // text after <|message|> until block is resolved

  feed(chunk: string): string {
    this.buf += chunk;
    let out = '';

    // Parse loop – simplified for brevity; assumes the rest of your existing
    // detection for tokens and block handling is still in place.
    // The only thing that matters for this change is the finalization behavior
    // for a completed "final" block (see `emitCompletedChannel()` below).

    // (… your existing incremental parser …)
    out += this.consumeAvailable();

    const cleaned = out;
    return cleaned;
  }

  flush() {
    // Flush any trailing completed content that didn't get emitted yet
    const cleaned = this.consumeAvailable(true);
    return cleaned;
  }

  // -----------------------------------------------------------------------
  // Everything below is a compact skeleton of the parser that you already
  // have in place. Keep your existing implementation; only ensure the
  // "final" case calls `joinTagAndMessage()` as shown.
  // -----------------------------------------------------------------------

  /** Consume from buffer and emit cleaned text. `atEOF` toggles lenient endings. */
  private consumeAvailable(atEOF = false): string {
    let out = '';

    // NOTE: Keep all your existing tokenization and PDA logic here.
    // The important part is: when a <|channel|>… block is completed,
    // call `emitCompletedChannel()` to produce `out`.

    // (parser body omitted)

    return out;
  }

  /** Called when a channel block completes; returns text to emit. */
  private emitCompletedChannel(channel: Chan, constrain: string, message: string): string {
    switch (channel) {
      case 'final': {
        // Special cases your code already handles (|json echo unwrap, etc.) should
        // happen before the generic mention join. Example:
        // if (constrain.trim() === '|json') { ... existing JSON echo unwrap ... }

        // NEW: join mention and message with normalized spacing
        return joinTagAndMessage(constrain.trim(), message);
      }

      case 'commentary': {
        // e.g. {"ok":true,"stdout":"@@user …"} -> unwrap stdout
        // (keep whatever you already have here)
        try {
          const obj = JSON.parse(message.trim());
          if (obj && typeof obj.stdout === 'string') return obj.stdout;
        } catch {
          /* fall through */
        }
        return ''; // commentary not user-visible by default
      }

      case 'analysis':
      case 'tool_call':
      case 'memory':
        // Drop
        return '';

      case 'tool_result':
        // unwrap tool_result payload
        return message;

      default:
        return message;
    }
  }
}

