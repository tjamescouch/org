// src/scheduler/filters.ts
//
// Centralized post-turn cleaning for agent/group/file channels.

import { createPDAStreamFilter } from "../utils/filter-passes/llm-pda-stream";

export class NoiseFilters {
  private readonly agentFilter: any;
  private readonly groupFilter: any;
  private readonly fileFilter: any;

  constructor() {
    this.agentFilter = createPDAStreamFilter();
    this.groupFilter = createPDAStreamFilter();
    this.fileFilter = createPDAStreamFilter();
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
