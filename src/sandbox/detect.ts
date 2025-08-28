import { spawnSync } from "child_process";

export type Backend = "podman" | "docker" | "mock";

/** Decide which sandbox backend to use. Env var wins. Then Podman, then Docker, last-resort mock. */
export function detectBackend(): Backend {
  const forced = (process.env.ORG_BACKEND || "").toLowerCase();
  if (forced === "podman" || forced === "docker" || forced === "mock") {
    return forced as Backend;
  }

  const has = (bin: string) =>
    spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;

  if (has("podman")) return "podman";
  if (has("docker")) return "docker";
  return "mock";
}

export function isMock(): boolean {
  return detectBackend() === "mock";
}
