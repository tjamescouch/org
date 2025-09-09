import { spawnSync } from "child_process";
import * as fs from "fs";
import { R } from "../runtime/runtime";

export type Backend = "podman" | "docker" | "local" | "mock";

function binExists(bin: string): boolean {
  try {
    return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Heuristics: are we already inside a container namespace? */
function inContainer(): boolean {
  try {
    if (R.env.container) return true;
    if (fs.existsSync("/.dockerenv")) return true;
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    return /docker|podman|kubepods/i.test(cgroup);
  } catch {
    return false;
  }
}

/** Normalize strings like "none" → "local" */
function normalizeEnvBackend(s: string | undefined): Backend | undefined {
  const v = String(s ?? "").toLowerCase().trim();
  switch (v) {
    case "podman": case "docker": case "local": case "mock": return v as Backend;
    case "none": case "host": case "native": return "local";
    default: return undefined;
  }
}

// src/sandbox/detect.ts
export function detectBackend(): Backend {
  // 0) Explicit backend wins (several aliases for historical envs)
  const explicit =
    normalizeEnvBackend(R.env.ORG_BACKEND) ||
    normalizeEnvBackend(R.env.ORG_ENGINE) ||
    normalizeEnvBackend(R.env.SANDBACKEND);
  if (explicit) return explicit;

  // 1) Already inside a container → do not nest
  if (inContainer()) return "local";

  // 2) Probe local engines (prefer Podman)
  if (binExists("podman")) return "podman";
  if (binExists("docker")) return "docker";

  // 3) Last resort: align with existing tests (mock)
  return "mock";
}

export function isMock(): boolean {
  return detectBackend() === "mock";
}
