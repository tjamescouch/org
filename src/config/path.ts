import fs from "node:fs";
import os from "node:os";
import { PATHS } from "./paths";
import { Logger } from "../logger";

/** Expand "~" and ignore nonsense; only keep existing dirs; de-dupe; whitelist first. */
export function buildPATH(basePATH: string, extra: string[] = []): string {
  const seen = new Set<string>();
  const out: string[] = [];

  const expand = (p: string) => p.replace(/^~(?=\/|$)/, os.homedir());

  const add = (p?: string) => {
    if (!p) return;
    if (p === "." || /\0/.test(p)) return;
    const dir = expand(p);
    seen.add(dir);
    out.push(dir);
  };

  // 1) Whitelist (authoritative, comes first)
  for (const p of PATHS) add(p);
  for (const p of extra) add(p);

  // 2) Whatever was already in PATH (kept, but deduped and after whitelist)
  for (const p of (basePATH || "").split(":")) add(p);

  return out.join(":");
}
