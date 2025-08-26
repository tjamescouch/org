// src/project/resolve.ts
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

export function resolveProjectDir(seed: string): string {
  try {
    const out = execFileSync("git", ["-C", seed, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    if (out) return out;
  } catch { /* fall through */ }

  let d = path.resolve(seed);
  while (true) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(`Could not locate project root from ${seed}. Pass --project <dir> or run inside the repo.`);
}
