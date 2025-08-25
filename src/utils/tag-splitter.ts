// src/utils/tag-splitter.ts
/**
 * TagSplitter (token-driven)
 * Splits text into TagPart[] using an allowlist of tokens.
 *
 * Supports:
 *   - Agent DM:  @@<agent> ...   and (optionally)  @<agent> ...
 *   - User:      @@<userToken> ...      /  @<userToken> ...
 *   - Group:     @@<groupToken> ...     /  @<groupToken> ...
 *   - File:      ##fileToken:NAME ...   /  #fileToken:NAME ...
 *              + (optionally) shorthand filename: ##PATH / #PATH
 *
 * Notes:
 * - Matching against allowlists is case-insensitive (original case is preserved in `tag`).
 * - “File shorthand” (##path/to.txt) is enabled by default; disable via `allowFileShorthand:false`.
 * - Content for a tag spans until the next recognized tag.
 * - Plain text before the first tag becomes a single group part.
 */

export type TagPart =
  | { kind: "agent"; tag: string; content: string; index: number }
  | { kind: "group"; tag: "group"; content: string; index: number }
  | { kind: "user";  tag: "user";  content: string; index: number }
  | { kind: "file";  tag: string;  content: string; index: number };

export type TagSplitterOptions = {
  /** Agent names allowed (e.g., ['alice','bob']). Default: [] */
  agentTokens?: string[];
  /** User tokens allowed (e.g., ['user']). Default: ['user'] */
  userTokens?: string[];
  /** Group tokens allowed (e.g., ['group']). Default: ['group'] */
  groupTokens?: string[];
  /** File keyword tokens allowed for the “file:NAME” form. Default: ['file'] */
  fileTokens?: string[];

  /** Accept single '@' in addition to '@@'. Default: true */
  allowSingleAt?: boolean;
  /** Accept single '#' in addition to '##'. Default: true */
  allowSingleHash?: boolean;
  /** Accept shorthand filename after hash sentinels (##PATH / #PATH). Default: true */
  allowFileShorthand?: boolean;

  /**
   * Treat '@'/'#' as a tag only when preceded by BOS or one of these chars
   * to avoid matching emails etc. Default: " \t\n\r,;:()[]{}\"'`<>"
   */
  boundaryChars?: string;
};

const DEFAULTS: Required<Omit<TagSplitterOptions,
  "agentTokens" | "userTokens" | "groupTokens" | "fileTokens">> & {
    agentTokens: string[]; userTokens: string[]; groupTokens: string[]; fileTokens: string[];
  } = {
  agentTokens: [],
  userTokens: ["user"],
  groupTokens: ["group"],
  fileTokens: ["file"],
  allowSingleAt: true,
  allowSingleHash: true,
  allowFileShorthand: true,
  boundaryChars: " \t\n\r,;:()[]{}\"'`<>",
};

const isWordChar = (ch: string) => /[A-Za-z0-9._-]/.test(ch);
// Allow slashes in filenames for shorthand (#/##)
const isFileNameChar = (ch: string) => /[A-Za-z0-9._\-\/]/.test(ch);

type Tok = { kind: "agent" | "group" | "user" | "file"; tag: string; start: number; end: number };

export class TagSplitter {
  static split(input: string, opts?: TagSplitterOptions): TagPart[] {
    const text = String(input ?? "");
    if (!text.trim()) return [{ kind: "group", tag: "group", content: "", index: 0 }];

    const cfg = {
      ...DEFAULTS,
      ...(opts ?? {}),
      agentTokens: (opts?.agentTokens ?? DEFAULTS.agentTokens).map(s => s.toLowerCase()),
      userTokens:  (opts?.userTokens  ?? DEFAULTS.userTokens).map(s => s.toLowerCase()),
      groupTokens: (opts?.groupTokens ?? DEFAULTS.groupTokens).map(s => s.toLowerCase()),
      fileTokens:  (opts?.fileTokens  ?? DEFAULTS.fileTokens).map(s => s.toLowerCase()),
    };

    const isBoundary = (i: number) => (i <= 0) || cfg.boundaryChars.includes(text[i - 1] ?? "");

    const toks: Tok[] = [];
    let i = 0;

    while (i < text.length) {
      // ---------- AT tags: @@token / @token ----------
      if (text[i] === "@" && isBoundary(i)) {
        const dbl = i + 1 < text.length && text[i + 1] === "@";
        const s = dbl ? 2 : 1;
        if (dbl || cfg.allowSingleAt) {
          let j = i + s;
          // Read token word
          let token = "";
          while (j < text.length && isWordChar(text[j])) { token += text[j]; j++; }

          if (token.length > 0) {
            const low = token.toLowerCase();
            // Only recognize tokens that are explicitly allowed
            if (cfg.groupTokens.includes(low)) {
              toks.push({ kind: "group", tag: token, start: i, end: j });
              i = j; continue;
            }
            if (cfg.userTokens.includes(low)) {
              toks.push({ kind: "user", tag: token, start: i, end: j });
              i = j; continue;
            }
            if (cfg.agentTokens.includes(low)) {
              toks.push({ kind: "agent", tag: token, start: i, end: j });
              i = j; continue;
            }
          }
        }
      }

      // ---------- HASH file tags: ##fileToken:NAME / #fileToken:NAME ----------
      if (text[i] === "#" && isBoundary(i)) {
        const dbl = i + 1 < text.length && text[i + 1] === "#";
        const s = dbl ? 2 : 1;
        if (dbl || cfg.allowSingleHash) {
          let j = i + s;
          // Read the leading token or shorthand path (allow slashes)
          let token = "";
          while (j < text.length && isFileNameChar(text[j])) { token += text[j]; j++; }

          let filePath = "";

          // Form: ##fileToken:NAME  (fileToken must be allowed)
          if (token && cfg.fileTokens.includes(token.toLowerCase()) && text[j] === ":") {
            j++;
            let name = "";
            while (j < text.length && !/\s/.test(text[j])) { name += text[j]; j++; }
            filePath = name;
          }
          // Shorthand: ##PATH (only if enabled and token is not an allowed keyword)
          else if (cfg.allowFileShorthand && token.length > 0) {
            filePath = token;
          }

          if (filePath) {
            let tag = filePath;
            if (!(tag.startsWith("/") || tag.startsWith("."))) tag = "./" + tag;
            toks.push({ kind: "file", tag, start: i, end: j });
            i = j; continue;
          }
        }
      }

      i++;
    }

    // No recognized tokens → whole text is one group message
    if (toks.length === 0) {
      return [{ kind: "group", tag: "group", content: text.trim(), index: 0 }];
    }

    // Build TagPart[]: content for each token runs until next token start
    const parts: TagPart[] = [];
    for (let k = 0; k < toks.length; k++) {
      const cur = toks[k];
      const nextStart = (k + 1 < toks.length) ? toks[k + 1].start : text.length;
      const raw = text.slice(cur.end, nextStart);
      const content = raw.replace(/^\s+/, "").replace(/\s+$/, "");
      const index = k;

      if (cur.kind === "file") {
        parts.push({ kind: "file", tag: cur.tag, content, index });
      } else if (cur.kind === "group") {
        parts.push({ kind: "group", tag: "group", content, index });
      } else if (cur.kind === "user") {
        parts.push({ kind: "user", tag: "user", content, index });
      } else {
        parts.push({ kind: "agent", tag: cur.tag, content, index });
      }
    }

    // Preamble (text before first recognized token) → @@group part, then reindex
    const firstStart = toks[0].start;
    const preamble = text.slice(0, firstStart).trim();
    if (preamble) {
      parts.unshift({ kind: "group", tag: "group", content: preamble, index: -1 });
      let idx = 0;
      for (const p of parts) (p as any).index = idx++;
    }

    return parts;
  }
}
