// src/scheduler/filters.ts
//
// Centralized post-turn cleaning for agent/group/file channels.

import { makePDAStreamFilter, PDAStreamFilter } from "../utils/filter-passes/llm-pda-stream";

export class NoiseFilters {
  private readonly agentFilter: PDAStreamFilter;
  private readonly groupFilter: PDAStreamFilter;
  private readonly fileFilter: PDAStreamFilter;

  constructor() {
    this.agentFilter = makePDAStreamFilter();
    this.groupFilter = makePDAStreamFilter();
    this.fileFilter = makePDAStreamFilter();
  }

  cleanAgent(s: string): string {
    return this.agentFilter.feed(s) + this.agentFilter.flush();
  }

  cleanGroup(s: string): string {
    return this.groupFilter.feed(s) + this.groupFilter.flush();
  }

  cleanFile(s: string): string {
    return this.fileFilter.feed(s) + this.fileFilter.flush();
  }
}
