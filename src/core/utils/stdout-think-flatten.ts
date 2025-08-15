import { flattenThink } from "./think";

/**
 * Monkey-patch stdout so that the "haiku" CoT block printed right after:
 *   **** <agent> @ <time>:
 * becomes a single line before the assistant’s actual answer.
 * Enabled only when SHOW_THINK=1.
 */
export function installStdoutThinkFlatten() {
  const orig = process.stdout.write.bind(process.stdout) as any;

  function transform(s: string): string {
    // Flatten short-line blocks (3+ lines of <= 24 chars) that appear
    // right after the agent header and before the assistant’s line.
    return s.replace(
      /(\*{4}\s[^\n]+\n)((?:[^\n]{1,24}\n){3,})(?=(?:assistant:|[A-Z][a-z]+!|Hello|Hi\b))/g,
      (_m, head, block) => head + flattenThink(block) + "\n"
    );
  }

  (process.stdout.write as any) = (chunk: any, enc?: any, cb?: any) => {
    try {
      const str = typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk) ? chunk.toString(enc || "utf8")
        : String(chunk);
      return orig(transform(str), enc, cb);
    } catch {
      return orig(chunk, enc, cb);
    }
  };
}
