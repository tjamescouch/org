// src/scheduler/round-robin-scheduler.ts
import { RandomScheduler } from "./random-scheduler";
import type { SchedulerOptions } from "./types";

/** Deterministic iteration order (no shuffling). */
export class RoundRobinScheduler extends RandomScheduler {
  constructor(opts: SchedulerOptions) {
    super({ ...opts, shuffle: (a) => a });
  }
}
