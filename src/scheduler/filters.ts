// src/scheduler/filters.ts
import { LLMNoiseFilter } from "../utils/llm-noise-filter";
import { extractCodeGuards } from "../utils/extract-code-blocks";

/**
 * Encapsulates LLM noise stripping per-channel.
 * Each filter is stateful (rolling tail), so keep them per-scheduler.
 */
export class NoiseFilters {
  readonly agent = new LLMNoiseFilter();
  readonly group = new LLMNoiseFilter();
  readonly file  = new LLMNoiseFilter();

  cleanAgent(s: string): string {
    const res = this.agent.feed(String(s ?? ""));
    return res.cleaned + this.agent.flush();
  }
  cleanGroup(s: string): string {
    const res = this.group.feed(String(s ?? ""));
    return res.cleaned + this.group.flush();
  }
  cleanFile(s: string): string {
    // Extract fenced code content first (drop chatty prose); then run the noise filter.
    const extracted = extractCodeGuards(String(s ?? "")).cleaned;
    const res = this.file.feed(extracted);
    return res.cleaned + this.file.flush();
  }
}
