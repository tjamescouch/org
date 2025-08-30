// src/utils/llm-adv-memory-scrub-pass.ts
//
// AdvancedMemoryScrubPass
// -----------------------
// Minimal, fence-aware "LLM quirks" scrubber for assistant text.
// - Keeps the original scheduler/console logs untouched (those never flow here).
// - Does NOT remove "Me:" (you intentionally feed it).
// - Removes only common model preambles / meta-chatter that add no value.
// - Preserves content inside fenced code blocks.
// - Streaming-safe: carries the last partial line; tracks fence state across chunks.

import { LLMNoiseFilterPass } from "./llm-noise-filter-pass";


type FenceDelim = "```" | "~~~";

const FINAL_PREFIXES = [
  "final answer",
  "final output",
  "answer",
  "output",
  "result",
  "final",
] as const;

// Lines that are pure meta/planner chatter; drop entire line if they match.
// IMPORTANT: keep these conservative—only patterns that rarely carry user value.
const META_DROP_RE: RegExp[] = [
  // As-an-AI disclaimers
  /^\s*as\s+an\s+ai(?:\s+language)?\s+model\b.*$/i,

  // Planner narration
  /^\s*(?:we|i)\s+(?:need|should|must)\b.*$/i,
  /^\s*let['’]s\b.*$/i,
  /^\s*(?:thus|therefore|so)\b.*$/i,
  /^\s*(?:the\s+user\s+(?:says|said|wants|asks?)\b.*)$/i,
  /^\s*(?:in\s+this\s+task|according\s+to|based\s+on\s+the\s+instructions)\b.*$/i,
  /^\s*we\s+just\s+need\b.*$/i,

  // Pure stage directions on their own line (variants)
  /^\s*[\(\[]\s*(?:analysis|thinking|deliberation|plan|scratch|reasoning|commentary|tool)\s*[\)\]]\s*$/i,
  /^\s*<\/?(?:analysis|thinking|deliberation|plan|scratch|reasoning|commentary|tool)>\s*$/i,
];

export class AdvancedMemoryScrubPass implements LLMNoiseFilterPass {
  private tail = "";
  private inFence: FenceDelim | "" = "";

  feed(chunk: string): { cleaned: string; removed: number }{
    if (!chunk) return { cleaned: "", removed: 0 };
    let s = this.tail + chunk;
    this.tail = "";
    let removed = 0;

    const endedWithNL = s.endsWith("\n");
    const lines = s.split("\n");
    const last = endedWithNL ? "" : lines.pop()!;

    const out: string[] = [];
    let lastEmitted = "";         // for adjacent-duplicate collapse

    for (let raw of lines) {
      const line = raw; // keep original for fence toggling/emit

      // --- Fence handling (preserve verbatim inside fences) ---
      const toggled = this.applyFenceToggles(line);
      if (this.inFence) {
        removed++;
        out.push(line);
        // Fence state already updated via applyFenceToggles
        continue;
      }

      // --- Outside fences: scrub line-by-line ---

      // 1) Strip common FINAL preambles but keep the content ("Final answer: X" -> "X")
      const stripped = stripFinalPreamble(line);

      // 2) Drop line entirely if it is pure meta/planner chatter (conservative)
      if (isPureMetaLine(stripped)) continue;

      // 3) Keep "Me:" exactly as-is (explicitly requested)
      // (No-op)

      // 4) Collapse adjacent duplicates (whitespace-insensitive)
      const norm = stripped.trim();
      if (norm.length > 0 && norm === lastEmitted) {
        continue;
      }

      removed++;
      out.push(stripped);
      if (norm.length > 0) lastEmitted = norm;
    }

    // collapse 3+ blank lines into a single blank line
    let joined = out.join("\n").replace(/\n{3,}/g, "\n\n");

    // restore trailing newline if the chunk ended with one
    if (endedWithNL) joined += "\n";

    // keep any partial last line in the tail
    this.tail = last ?? "";

    return { cleaned: joined, removed };
  }

  flush(): string {
    const t = this.tail;
    this.tail = "";
    return t;
  }

  // Count even/odd occurrences of ``` / ~~~ to toggle fence state safely even if they
  // appear mid-line. This mirrors conservative behavior used in the core filter.
  private applyFenceToggles(line: string): void {
    const tickCount = (line.match(/```/g) || []).length;
    const tildeCount = (line.match(/~~~/g) || []).length;

    // Toggle once for each odd occurrence; if open and we see the same delimiter odd times, close.
    if (tickCount % 2 === 1) {
      this.inFence = this.inFence === "```" ? "" : "```";
    }
    if (tildeCount % 2 === 1) {
      this.inFence = this.inFence === "~~~" ? "" : "~~~";
    }
  }
}

// ---------- helpers ----------

// Strip “Final answer: ” / “Answer:” / “Output:” prefixes (Markdown bold tolerated).
function stripFinalPreamble(line: string): string {
  // Allow optional Markdown bold/italics around the label (**Answer:**, __Final Output:__)
  const m = line.match(
    /^\s*(?:\*\*|__|\*|_)?\s*([A-Za-z ]{3,20})\s*(?:\*\*|__|\*|_)?\s*:\s*(.*)$/
  );
  if (!m) return line;

  const label = m[1].trim().toLowerCase();
  const rest = m[2];

  if (FINAL_PREFIXES.includes(label as any)) {
    return rest;
  }
  // Handle "So the answer is: …"
  if (/(?:the\s+answer\s+is)$/i.test(label)) {
    return rest;
  }

  return line;
}

function isPureMetaLine(line: string): boolean {
  // Empty / whitespace-only lines are not meta—they are layout—keep them.
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Do NOT treat "Me: ..." as meta—explicitly preserved.
  if (/^me:\s*/i.test(trimmed)) return false;

  // Run the conservative drop list
  for (const re of META_DROP_RE) {
    if (re.test(trimmed)) return true;
  }
  return false;
}
