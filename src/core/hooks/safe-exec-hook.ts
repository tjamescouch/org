import * as fs from "node:fs";
import type * as CP from "node:child_process";
import { confirm, shouldUseSafeMode } from "../utils/safe-confirm";

/** One-time guard */
let INSTALLED = false;

function interpolate(tpl: TemplateStringsArray, vals: unknown[]): string {
  let s = "";
  for (let i = 0; i < tpl.length; i++) {
    s += tpl[i];
    if (i < vals.length) s += String(vals[i]);
  }
  return s.trim();
}

/** Tiny sync prompt used for sync APIs (exec/execFile). TTY-only. */
function confirmSyncPreview(preview: string): boolean {
  if (!shouldUseSafeMode()) return true;
  if (!process.stdin.isTTY) return false;

  const msg = `[SAFE] About to run: ${preview} [y/N] `;
  fs.writeSync(1, msg);
  try { (process.stdin as any).setRawMode?.(true); } catch {}
  const buf = Buffer.alloc(1);
  const n = fs.readSync(0, buf, 0, 1, null);
  try { (process.stdin as any).setRawMode?.(false); } catch {}
  fs.writeSync(1, "\n");

  const c = (n > 0 ? String(buf[0] ? String.fromCharCode(buf[0]) : "") : "").toLowerCase();
  return c === "y";
}

export type SafeExecHookOptions = {
  /** for tests – inject a fake Bun */
  bun?: any;
  /** for tests – inject a fake cp */
  cp?: Partial<typeof import("node:child_process")>;
  /** for tests – inject an ask() replacement used by Bun.$ path */
  ask?: (q: string) => Promise<boolean>;
};

/**
 * Install hooks that prompt in SAFE_MODE before running commands.
 * - Bun.$  (async; we can await confirm())
 * - child_process.exec / execFile (sync; use confirmSyncPreview)
 */
export function installSafeExecHook(opts?: SafeExecHookOptions): void {
  if (INSTALLED) return;
  if (!shouldUseSafeMode()) return; // only do work when SAFE_MODE applies
  INSTALLED = true;

  const ask = opts?.ask ?? (q => confirm(q));

  // ---- Hook Bun.$ (template tag) if available ----
  const BunObj: any = opts?.bun ?? (globalThis as any).Bun;
  if (BunObj && typeof BunObj.$ === "function") {
    const orig$ = BunObj.$;

    // Use a Proxy to intercept the tag call.
    BunObj.$ = new Proxy(orig$, {
      apply(target, thisArg, argArray) {
        // argArray: [templateStringsArray, ...values]
        const [tpl, ...vals] = argArray as [TemplateStringsArray, ...unknown[]];
        const preview = interpolate(tpl as any, vals);

        // Return a thenable object like Bun.$ does: resolve(0) when skipped.
        const run = async () => {
          const ok = await ask(`[SAFE] About to run: ${preview}`);
          if (!ok) {
            // emulate a minimal "ProcessPromise" interface most code uses
            const p = Promise.resolve(0) as any;
            p.exitCode = 0;
            p.stdout = new Uint8Array();
            p.stderr = new Uint8Array();
            p.text = async () => "";
            return p;
          }
          return Reflect.apply(target as any, thisArg, argArray);
        };

        // Make sure callers can do: await Bun.$`...`
        const proxyPromise: any = (async () => run())();
        // Provide a .text() even if caller forgets to await first
        proxyPromise.text ??= async () => "";
        return proxyPromise;
      }
    });
  }

  // ---- Hook child_process.exec / execFile for completeness ----
  const cp: any = opts?.cp ?? require("node:child_process") as typeof import("node:child_process");

  if (cp && typeof cp.exec === "function") {
    const origExec: typeof cp.exec = cp.exec.bind(cp);
    cp.exec = function patchedExec(command: any, options?: any, callback?: any) {
      const preview = String(command ?? "").trim();
      if (!confirmSyncPreview(preview)) {
        if (typeof options === "function") {
          // exec(command, callback)
          options(null, "", "");
          return {} as any;
        }
        if (typeof callback === "function") {
          callback(null, "", "");
          return {} as any;
        }
        return {} as any;
      }
      return origExec(command, options as any, callback as any);
    } as any;
  }

  if (cp && typeof cp.execFile === "function") {
    const origExecFile: typeof cp.execFile = cp.execFile.bind(cp);
    cp.execFile = function patchedExecFile(file: any, args?: any, options?: any, callback?: any) {
      const preview = [file, ...(Array.isArray(args) ? args : [])].filter(Boolean).join(" ");
      if (!confirmSyncPreview(preview)) {
        const cb = (typeof options === "function" ? options
                  : typeof callback === "function" ? callback : null) as any;
        cb?.(null, "", "");
        return {} as any;
      }
      return origExecFile(file, args as any, options as any, callback as any);
    } as any;
  }
}
