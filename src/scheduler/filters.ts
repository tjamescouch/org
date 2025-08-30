// src/scheduler/filters.ts
//
// Centralized post-turn cleaning for agent/group/file channels.

import LLMNoiseFilter from "../utils/llm-noise-filter";

export class NoiseFilters {
  private readonly agentFilter: LLMNoiseFilter;
  private readonly groupFilter: LLMNoiseFilter;
  private readonly fileFilter:  LLMNoiseFilter;

  constructor() {
    this.agentFilter = new LLMNoiseFilter();
    this.groupFilter = new LLMNoiseFilter();
    this.fileFilter  = new LLMNoiseFilter();
  }

  cleanAgent(s: string): string {
    return s;//this.agentFilter.feed(s).cleaned + this.agentFilter.flush();
  }

  cleanGroup(s: string): string {
    return s;//this.groupFilter.feed(s).cleaned + this.groupFilter.flush();
  }

  cleanFile(s: string): string {
    return s;//this.fileFilter.feed(s).cleaned + this.fileFilter.flush();
  }
}
