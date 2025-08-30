// src/utils/tag-protect.ts
//
// Stream-safe protection for agent/file tags so filters can strip <|…|> wrappers
// without corrupting @@user / @@bob / ##file tokens—even when tags arrive split
// across chunks.

const OPEN = "⟦TAG:";
const CLOSE = "⟧";
const CARRY_LEN = 32; // small lookbehind to catch split tokens

const TAG_RE = /@@[A-Za-z0-9_-]+|##[A-Za-z0-9_.\/-]+/g;

export class StreamingTagProtector {
  private carry = ""; // carry partial line to catch split tags like '@@us' + 'er'

  /** Protect a streaming chunk; returns masked chunk (safe for filtering). */
  feedProtect(chunk: string): string {
    const s = this.carry + (chunk ?? "");
    // Only scan the tail window so we don't re-mask large text repeatedly.
    const cut = Math.max(0, s.length - CARRY_LEN);
    const head = s.slice(0, cut);
    let tail = s.slice(cut);
    tail = tail.replace(TAG_RE, encTag);
    this.carry = s.slice(-CARRY_LEN); // keep last window for next chunk
    return head + tail;
  }

  /** Undo protection for a filtered chunk. */
  unprotect(chunk: string): string {
    return (chunk ?? "").replace(/⟦TAG:([^⟧]+)\⟧/g, (_, p) => decodeURIComponent(p));
  }

  /** Flush any remainder (no-op for now; structure kept for symmetry). */
  flush(): string {
    const t = this.carry;
    this.carry = "";
    return t ? t.replace(TAG_RE, encTag) : "";
  }
}

/** One-shot protect/unprotect (useful for post-turn cleaning). */
export function protectWhole(s: string): string {
  return String(s ?? "").replace(TAG_RE, encTag);
}
export function unprotectWhole(s: string): string {
  return String(s ?? "").replace(/⟦TAG:([^⟧]+)\⟧/g, (_, p) => decodeURIComponent(p));
}

function encTag(m: string): string {
  return `${OPEN}${encodeURIComponent(m)}${CLOSE}`;
}
