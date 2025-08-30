// src/utils/filter-passes/llm-adv-memory-scrub-pass.ts
//
// Conservative LLM quirks scrub. Safe defaults; we’ll expand as we see cases.

import type { LLMNoiseFilterPass, PassFeedResult } from "./llm-noise-filter-pass";

type FenceDelim = "```" | "~~~";

const FINAL_PREFIXES = [
  "final answer",
  "final output",
  "answer",
  "output",
  "result",
  "final",
] as const;

const META_DROP_RE: RegExp[] = [
  /^\s*as\s+an\s+ai(?:\s+language)?\s+model\b.*$/i,
  /^\s*(?:we|i)\s+(?:need|should|must)\b.*$/i,
  /^\s*let['’]s\b.*$/i,
  /^\s*(?:thus|therefore|so)\b.*$/i,
  /^\s*(?:the\s+user\s+(?:says|said|wants|asks?)\b.*)$/i,
  /^\s*(?:in\s+this\s+task|according\s+to|based\s+on\s+the\s+instructions)\b.*$/i,
  /^\s*we\s+just\s+need\b.*$/i,
  /^\s*[\(\[]\s*(?:analysis|thinking|deliberation|plan|scratch|reasoning|commentary|tool)\s*[\)\]]\s*$/i,
  /^\s*<\/?(?:analysis|thinking|deliberation|plan|scratch|reasoning|commentary|tool)>\s*$/i,
];

export class AdvancedMemoryScrubPass implements LLMNoiseFilterPass {
  private tail = "";
  private inFence: FenceDelim | "" = "";

  feed(chunk: string): PassFeedResult {
    if (!chunk) return { cleaned: "" };
    let s = this.tail + chunk;
    this.tail = "";

    const endedWithNL = s.endsWith("\n");
    const lines = s.split("\n");
    const last = endedWithNL ? "" : lines.pop()!;

    const out: string[] = [];
    let prevNorm = "";

    for (const line of lines) {
      this.toggleFences(line);
      if (this.inFence) {
        out.push(line);
        continue;
      }

      const stripped = stripFinalPreamble(line);
      if (isPureMetaLine(stripped)) continue;

      // Keep "Me:" – intentionally present for agent disambiguation.
      const norm = stripped.trim();
      if (norm && norm === prevNorm) continue;

      out.push(stripped);
      if (norm) prevNorm = norm;
    }

    let joined = out.join("\n").replace(/\n{3,}/g, "\n\n");
    if (endedWithNL) joined += "\n";
    this.tail = last ?? "";
    return { cleaned: joined };
  }

  flush(): string {
    const t = this.tail;
    this.tail = "";
    return t;
  }

  private toggleFences(line: string) {
    const tickCount = (line.match(/```/g) || []).length;
    const tildeCount = (line.match(/~~~/g) || []).length;
    if (tickCount % 2 === 1) this.inFence = this.inFence === "```" ? "" : "```";
    if (tildeCount % 2 === 1) this.inFence = this.inFence === "~~~" ? "" : "~~~";
  }
}

function stripFinalPreamble(line: string): string {
  const m = line.match(/^\s*(?:\*\*|__|\*|_)?\s*([A-Za-z ]{3,20})\s*(?:\*\*|__|\*|_)?\s*:\s*(.*)$/);
  if (!m) return line;
  const label = m[1].trim().toLowerCase();
  const rest = m[2];
  if ((FINAL_PREFIXES as readonly string[]).includes(label)) return rest;
  if (/(?:the\s+answer\s+is)$/i.test(label)) return rest;
  return line;
}

function isPureMetaLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^me:\s*/i.test(t)) return false;
  return META_DROP_RE.some((re) => re.test(t));
}
