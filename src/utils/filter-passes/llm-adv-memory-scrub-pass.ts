// src/utils/llm-adv-memory-scrub-pass.ts
export class AdvancedMemoryScrubPass {
  private tail = "";

  feed(s: string): string {
    if (!s) return "";
    let t = this.tail + s;
    this.tail = "";

    t = t.replace(/^\s*\[[^\]\n]+\]\s+wrote\.\s+No tools used\.\s*\n?/gim, "");
    t = t.replace(/^[ \t]*[A-Za-z0-9_-]+\s+start\s*\{[\s\S]*?\}\s*\n?/gim, "");
    t = t.replace(/^[ \t]*[A-Za-z0-9_-]+\s+\.\.\.\s*\n?/gim, "");

    return t;
  }

  flush(): string { const t = this.tail; this.tail = ""; return t; }
}
