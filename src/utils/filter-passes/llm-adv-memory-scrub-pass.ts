// src/utils/llm-adv-memory-scrub-pass.ts
//
// AdvancedMemoryScrubPass: conservative banner/debug scrubs.
// Runs after final-message extraction, outside fences (fences already preserved by previous passes).

export class AdvancedMemoryScrubPass {
  private tail = ""; // kept for symmetry; currently not used for carry

  feed(s: string): string {
    if (!s) return "";
    let t = this.tail + s;
    this.tail = "";

    // 1) Drop `[agent] wrote. No tools used.` banners (with trailing newline if present)
    t = t.replace(/^\s*\[[^\]\n]+\]\s+wrote\.\s+No tools used\.\s*\n?/gim, "");

    // 2) Drop `agent start { ... }` debug blocks
    t = t.replace(/^[ \t]*[A-Za-z0-9_-]+\s+start\s*\{[\s\S]*?\}\s*\n?/gim, "");

    // 3) Drop lone `agent ...` planning banners on a line by themselves
    t = t.replace(/^[ \t]*[A-Za-z0-9_-]+\s+\.\.\.\s*\n?/gim, "");

    return t;
  }

  flush(): string {
    const t = this.tail;
    this.tail = "";
    return t;
  }
}
