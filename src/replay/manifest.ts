// src/replay/manifest.ts
// Typed manifest + helpers for writing a session's results.

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { ExecSpec } from "../sandbox/policy";

export interface StepMeta {
  idx: number;
  cmd: string;
  startedAt: string;
  endedAt: string;
  exitCode: number;
  killedBy?: "timeout" | "oom" | "signal";
  stdoutRel: string; // relative to runDir
  stderrRel: string;
  patchRel?: string; // optional per-step patch (baseline->this step)
}

export interface ArtifactMeta {
  pathRel: string; // relative to runDir
  sha256: string;
  size: number;
}

export interface RunManifest {
  spec: ExecSpec;
  startedAt: string;
  endedAt: string;
  container: { backend: "podman" | "docker"; name: string; version?: string };
  baselineCommit?: string;
  exitSummary: { steps: number; lastExitCode: number };
  fullPatchRel?: string; // session patch (baseline..HEAD)
  steps: StepMeta[];
  artifacts: ArtifactMeta[];
  host: { platform: NodeJS.Platform; release: string; arch: string };
}

export async function ensureDir(p: string) {
  await fsp.mkdir(p, { recursive: true });
}

export async function writeJsonPretty(file: string, data: unknown) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function initRunDirs(runDir: string) {
  await ensureDir(runDir);
  await ensureDir(path.join(runDir, "steps"));
  await ensureDir(path.join(runDir, "artifacts"));
}

export function rel(runDir: string, abs: string | undefined): string | undefined {
  if (!abs) return undefined;
  return path.relative(runDir, abs);
}
