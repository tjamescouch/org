// src/scheduler.ts
// Backward-compat shim. The real implementation now lives under src/scheduler/.
// Keeping this file avoids changing import paths elsewhere in the repo.
export { RandomScheduler, RoundRobinScheduler } from "../scheduler";
export type { Responder } from "./types";

export interface SchedulerLike {
  // Suggested (but optional) methods the application scheduler may expose.
  enqueue?(item: { role: "user"; content: string }): void | Promise<void>;
  enqueueUserText?(text: string): void | Promise<void>;
  send?(text: string): void | Promise<void>;
  stop?(): void | Promise<void>;
  drain?(): void | Promise<boolean>;
  stopDraining?(): void | Promise<void>;
  isDraining?(): boolean;
  handleUserInterjection?(text: string): void | Promise<void>;
}
