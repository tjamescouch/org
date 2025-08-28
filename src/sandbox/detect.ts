import { spawnSync } from "child_process";

export type SandboxBackend = "none" | "podman" | "mock";

export function detectBackend(): SandboxBackend {
  const forced = (process.env.SANDBOX_BACKEND || "").toLowerCase() as SandboxBackend;
  if (forced === "podman" || forced === "mock" || forced === "none") return forced;

  // Prefer podman only if it’s actually available
  try {
    const r = spawnSync("podman", ["version"], { stdio: "ignore" });
    if ((r.status ?? 1) === 0) return "podman";
  } catch {
    // ignore – podman not present
  }
  return "none";
}
