import { spawnSync } from "child_process";
import * as fs from "fs";

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
    if (fs.existsSync("/.dockerenv")) return true;
    if (fs.existsSync("/run/.containerenv")) return true;
    if (process.env.CONTAINER || process.env.DOCKER_CONTAINER) return true;
    const cg = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (/docker|kubepods|containerd|podman/i.test(cg)) return true;
  } catch {}
  return false;
}

/** Decide which sandbox backend to use. Env var wins. Then container→local, then podman, docker, mock. */
//export function detectBackend(): Backend {
//  const forced = (process.env.ORG_BACKEND || "").toLowerCase().trim();
//  if (forced === "podman" || forced === "docker" || forced === "local" || forced === "mock") {
//    return forced as Backend;
//  }
//
//  if (inContainer()) return "local";
//  if (binExists("podman")) return "podman";
//  if (binExists("docker")) return "docker";
//  return "mock";
//}
export function detectBackend(): "podman" | "none" | "mock" {
  // Force "none" if we're already inside a container, or SANDBACKEND=none
  const forced = String(process.env.SANDBACKEND || "").toLowerCase();
  if (forced === "none") return "none";
  if (process.env.container) return "none";
  return "podman";
}

export function isMock(): boolean {
  return detectBackend() === "mock";
}

