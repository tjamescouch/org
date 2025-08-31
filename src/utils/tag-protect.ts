// src/utils/tag-protect.ts
//
// Stream-safe protection for agent/file tags so filters can strip <|…|> wrappers
// without corrupting @@user / @@bob / ##file tokens—even when tags arrive split
// across chunks.
//
// This version uses ASCII markers: [TAG:...]. Both streaming and post-turn flow
// use the same encode/decode so unprotection always matches.

const OPEN = "[TAG:";
const CLOSE = "]";
const CARRY_LEN = 48; // lookbehind to catch split tokens like '@@us' + 'er'

const TAG_RE = /@@[A-Za-z0-9_-]+|##[A-Za-z0-9_.\/-]+/g;

export class StreamingTagProtector {
  private carry = "";

  /** Protect a streaming chunk; returns masked chunk (safe for filtering). */
  feedProtect(chunk: string): string {
    const s = this.carry + (chunk ?? "");
    // Only rescan a tail window so we don't re-mask large text every time.
    const cut = Math.max(0, s.length - CARRY_LEN);
    const head = s.slice(0, cut);
    let tail = s.slice(cut);
    tail = tail.replace(TAG_RE, encTag);
    this.carry = s.slice(-CARRY_LEN);
    return head + tail;
  }

  /** Undo protection for a filtered chunk. */
  unprotect(chunk: string): string {
    return (chunk ?? "").replace(/\[TAG:([^\]]+)\]/g, (_, p) => decodeURIComponent(p));
  }

  /** Flush any remainder: protect it and return the protected remainder. */
  flush(): string {
    if (!this.carry) return "";
    const out = this.carry.replace(TAG_RE, encTag);
    this.carry = "";
    return out;
  }
}

/** One-shot protect/unprotect helpers for post-turn cleaning. */
export function protectWhole(s: string): string {
  return String(s ?? "").replace(TAG_RE, encTag);
}
export function unprotectWhole(s: string): string {
  return String(s ?? "").replace(/\[TAG:([^\]]+)\]/g, (_, p) => decodeURIComponent(p));
}

function encTag(m: string): string {
  return `${OPEN}${encodeURIComponent(m)}${CLOSE}`;
}
