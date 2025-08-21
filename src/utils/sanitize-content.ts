  /**
   * Unescape simple escaped newlines if the model returned \\n without real \n.
   * If real newlines are already present, leave content as-is.
   */
  export function sanitizeContent(text: string): string {
    const s = String(text ?? "");
    if (s.includes("\\n") && !s.includes("\n")) {
      return s.replace(/\\r\\n/g, "\r\n").replace(/\\n/g, "\n");
    }
    return s;
  }