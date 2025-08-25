// src/scheduler.ts
// Backward-compat shim. The real implementation now lives under src/scheduler/.
// Keeping this file avoids changing import paths elsewhere in the repo.
export { RandomScheduler, RoundRobinScheduler } from "./scheduler/index";
export type { Responder } from "./scheduler/types";
