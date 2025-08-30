// src/scheduler/filters.ts
import { LLMNoiseFilter } from "../utils/llm-noise-filter";
import { extractCodeGuards } from "../utils/extract-code-blocks";
import { LLMNoiseFilterFirstPass } from "../utils/filter-passes/llm-noise-filter-first-pass";
import { FinalChannelPass } from "../utils/filter-passes/llm-final-channel-pass";
import { AdvancedMemoryScrubPass } from "../utils/filter-passes/llm-adv-memory-scrub-pass";

/**
 * Protect scheduler tags from being altered by the noise filter.
 * We wrap them in private-use sentinels before filtering and unwrap after.
 */
const S = {
  start: "\uE000",
  end: "\uE001",
};

const TAG_RE = /@@(?:user|group|[a-z][\w-]*)\b/gi;

function protectTags(s: string): string {
  return s.replace(TAG_RE, m => `${S.start}${m}${S.end}`);
}
function unprotectTags(s: string): string {
  const re = new RegExp(`${S.start}(@@(?:user|group|[a-z][\\w-]*)\\b)${S.end}`, "gi");
  return s.replace(re, (_m, tag) => tag);
}

/**
 * Encapsulates LLM noise stripping per-channel.
 * Each filter is stateful (rolling tail), so keep them per-scheduler.
 */
export class NoiseFilters {
  readonly agent = new LLMNoiseFilter([
    new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
    new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
    new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
  ]);
  readonly group = new LLMNoiseFilter([
    new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
    new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
    new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
  ]);
  readonly file = new LLMNoiseFilter([
    new LLMNoiseFilterFirstPass(), // preserves legacy sentinel/fence behavior
    new FinalChannelPass(),        // handles <|channel|>final … <|message|>… + commentary unwrap
    new AdvancedMemoryScrubPass(), // minimal "LLM quirks" scrub (safe by default)
  ]);

  cleanAgent(s: string): string {
    const masked = protectTags(String(s ?? ""));
    const res = this.agent.feed(masked);
    return unprotectTags(res.cleaned + this.agent.flush());
  }
  cleanGroup(s: string): string {
    const masked = protectTags(String(s ?? ""));
    const res = this.group.feed(masked);
    return unprotectTags(res.cleaned + this.group.flush());
  }
  //cleanFile(s: string): string {
  //  // Extract fenced code content first (drop chatty prose); then run the noise filter.
  //  const extracted = extractCodeGuards(String(s ?? "")).cleaned;
  //  const masked = protectTags(extracted);
  //  const res = this.file.feed(masked);
  //  return unprotectTags(res.cleaned + this.file.flush());
  //}
  // src/scheduler/filters.ts
  cleanFile(s: string): string {
    const raw = String(s ?? "");
    const extracted = extractCodeGuards(raw).cleaned;
    const body = extracted && extracted.trim().length ? extracted : raw;  // fallback
    const res = this.file.feed(body);
    return res.cleaned + this.file.flush();
  }

}
