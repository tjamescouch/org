// src/sandbox/detect.ts
import { spawnSync } from "child_process";

export type SandboxBackend = "podman" | "mock";

/** Decide which backend to use.  Defaults to "mock" when Podman isn't available. */
export function detectBackend(): SandboxBackend {
  const forced = (process.env.SANDBOX_BACKEND || "").toLowerCase() as SandboxBackend;
  if (forced === "podman" || forced === "mock") return forced;

  // Prefer Podman only when it is available and reachable
  const v = spawnSync("podman", ["version"], { stdio: "ignore" });
  if (v.status === 0) return "podman";
  return "mock";
}
