// src/sandbox/detect.ts
export type Backend = "local";

export function inContainer(): boolean {
  // Always "true" for our supported execution path; retained to avoid refactors elsewhere.
  return true;
}

/** Container-first design: tools run "locally" (inside the container). */
export function detectBackend(): Backend {
  return "local";
}
