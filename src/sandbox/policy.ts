
// src/sandbox/policy.ts
import { randomUUID } from "crypto";
import * as path from "path";
import * as os from "os";

type NetPolicy =
    | { mode: "deny" }
    | { mode: "allow"; allowCidrs: string[] };

interface ExecLimits {
    timeoutMs: number;
    memMiB: number;
    cpuCores: number;
    stdoutMax: number; // bytes
    pidsMax: number;
}

interface WritePolicy {
    allow: string[]; // globs (under /work) allowed to be modified/created
    deny: string[];
}

export interface ExecPolicy {
    projectDir: string;      // host absolute path to the repo root
    runRoot: string;         // host absolute path for .org/runs (artifacts)
    image: string;           // container image
    net: NetPolicy;
    limits: ExecLimits;
    write: WritePolicy;
    keepScratch?: boolean;   // keep /work host dir for debugging
}

export interface ExecSpec {
    id: string;
    image: string;
    projectDir: string;      // mounted RO at /project
    workHostDir: string;     // mounted RW at /work  (now OUTSIDE the repo)
    runDir: string;          // .org/runs/<id> (inside repo, fine)
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
            stdoutMax: opts.limits?.stdoutMax ?? 1_048_576,
            pidsMax: opts.limits?.pidsMax ?? 128,
        },
        write: {
            // keep conservative defaults
            allow: opts.write?.allow ?? ["*", "**/*"],
            deny:  opts.write?.deny  ?? [".git/**", ".org/**", ".env", "**/*.pem", ".github/**"]
        },
        keepScratch: opts.keepScratch ?? false,
    };
}

function toSpec(p: ExecPolicy): ExecSpec {
    const id = randomUUID();
    const runDir = path.join(p.runRoot, "runs", id);

    // IMPORTANT: scratch goes OUTSIDE the project to avoid rsync self-copy.
    const scratchBase =
        process.env.ORG_SCRATCH_BASE
            ? path.resolve(process.env.ORG_SCRATCH_BASE)
            : path.join(os.tmpdir(), "org-sessions");

    const workHostDir = path.join(scratchBase, `session-${id}`);
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

type ExecPolicy2 = {
  /** Allow outbound network calls from inside the container */
  allowNetwork: boolean;
  /** Allow invoking any binary (or restrict to a list) */
  allowBin: "all" | string[];
  /** Relative-to-/work globs that can be written to */
  writeAllow: string[];
};

/** Default policy; becomes fully open if ORG_TRUSTED=1 or ORG_POLICY=open. */
function defaultExecPolicy(): ExecPolicy2 {
  if (process.env.ORG_TRUSTED === "1" || process.env.ORG_POLICY === "open") {
    // Fully permissive inside the container (safest place to do it).
    return {
      allowNetwork: true,
      allowBin: "all",
      writeAllow: ["**"],  // anything under /work
    };
  }
  // Conservative defaults (tweak these if you like)
  return {
    allowNetwork: true,
    allowBin: "all",
    writeAllow: [".org/**", "tmp/**", "dist/**", "build/**"],
  };
}