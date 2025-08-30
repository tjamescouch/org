// src/scheduler/filters.ts
//
// Centralized post-turn cleaning for agent/group/file channels.

import { extractCodeGuards } from "../utils/extract-code-blocks";
import LLMNoiseFilter from "../utils/llm-noise-filter";
import { protectWhole, unprotectWhole } from "../utils/tag-protect";

export class NoiseFilters {
  private readonly agentFilter: LLMNoiseFilter;
  private readonly groupFilter: LLMNoiseFilter;
  private readonly fileFilter: LLMNoiseFilter;

  constructor() {
    // All channels use the same pipeline for now; split later if needed.
    this.agentFilter = LLMNoiseFilter.createDefault();
    this.groupFilter = LLMNoiseFilter.createDefault();
    this.fileFilter  = LLMNoiseFilter.createDefault();
  }

  cleanAgent(s: string): string {
    const masked = protectWhole(String(s ?? ""));
    const out = this.agentFilter.feed(masked).cleaned + this.agentFilter.flush();
    return unprotectWhole(out);
  }

  cleanGroup(s: string): string {
    const masked = protectWhole(String(s ?? ""));
    const out = this.groupFilter.feed(masked).cleaned + this.groupFilter.flush();
    return unprotectWhole(out);
  }

  cleanFile(s: string): string {
    const masked = protectWhole(String(s ?? ""));
    const extracted = extractCodeGuards(masked).cleaned;
    const out = this.fileFilter.feed(extracted).cleaned + this.fileFilter.flush();
    return unprotectWhole(out);
  }
}
