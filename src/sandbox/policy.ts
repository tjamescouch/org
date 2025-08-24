// src/sandbox/policy.ts
// Execution policy → concrete ExecSpec used by the sandbox backend.

import { randomUUID } from "crypto";
import * as path from "path";

export type NetPolicy =
  | { mode: "deny" }
  | { mode: "allow"; allowCidrs: string[] };

export interface ExecLimits {
  timeoutMs: number;
  memMiB: number;
  cpuCores: number;
  stdoutMax: number; // bytes
  pidsMax: number;
}

export interface WritePolicy {
  allow: string[]; // globs (under /work) allowed to be modified/created
}

export interface ExecPolicy {
  projectDir: string;      // host absolute path to the repo root
  runRoot: string;         // host absolute path for .org/runs and scratch
  image: string;           // container image (pin by digest if possible)
  net: NetPolicy;          // network policy for the whole session
  limits: ExecLimits;      // per-call ceilings; container has coarser caps
  write: WritePolicy;      // allowed write locations (under /work)
  keepScratch?: boolean;   // keep /work host dir for debugging
}

export interface ExecSpec {
  id: string;                      // run/session id (uuid)
  image: string;                   // image name@digest
  projectDir: string;              // host repo dir (mounted RO at /project)
  workHostDir: string;             // host scratch dir (mounted RW at /work)
  runDir: string;                  // host run dir (.org/runs/<id>)
  net: NetPolicy;
  limits: ExecLimits;
  write: WritePolicy;
}

export function defaultPolicy(opts: {
  projectDir: string;
  runRoot?: string;
  image?: string;
  net?: NetPolicy;
  limits?: Partial<ExecLimits>;
  write?: Partial<WritePolicy>;
  keepScratch?: boolean;
}): ExecPolicy {
  const projectDir = path.resolve(opts.projectDir);
  const runRoot = path.resolve(opts.runRoot ?? path.join(projectDir, ".org"));
  return {
    projectDir,
    runRoot,
    image: opts.image ?? "localhost/org-build:debian-12",
    net: opts.net ?? { mode: "deny" },
    limits: {
      timeoutMs: opts.limits?.timeoutMs ?? 30_000,
      memMiB: opts.limits?.memMiB ?? 512,
      cpuCores: opts.limits?.cpuCores ?? 1,
      stdoutMax: opts.limits?.stdoutMax ?? 1_048_576, // 1 MiB
      pidsMax: opts.limits?.pidsMax ?? 128,
    },
    write: {
      allow: opts.write?.allow ?? ["src/**", "include/**", "build/**", "tmp/**", "CMakeLists.txt"],
    },
    keepScratch: opts.keepScratch ?? false,
  };
}

export function toSpec(p: ExecPolicy): ExecSpec {
  const id = randomUUID();
  const runDir = path.join(p.runRoot, "runs", id);
  const workHostDir = path.join(p.runRoot, "tmp", `session-${id}`);
  return {
    id,
    image: p.image,
    projectDir: p.projectDir,
    workHostDir,
    runDir,
    net: p.net,
    limits: p.limits,
    write: p.write,
  };
}
