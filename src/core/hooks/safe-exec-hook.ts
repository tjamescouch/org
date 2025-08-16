import * as fs from "node:fs";
import type * as CP from "node:child_process";
import { confirm, shouldUseSafeMode } from "../utils/safe-confirm";

/** current ask function (can be replaced on re-install) */
let ASK: (q: string) => Promise<boolean> = (q) => confirm(q);

/** child_process patch state */
let CP_INSTALLED = false;
let ORIG_EXEC: any = null;
let ORIG_EXECFILE: any = null;

/** Track every Bun.$ we've patched so we can (a) avoid double patch, (b) restore in tests */
let PATCHED_BUNS = new WeakSet<any>();
const ORIG_BUN_DOLLAR = new Map<any, any>();

function interpolate(tpl: TemplateStringsArray, vals: unknown[]): string {
  let s = "";
  for (let i = 0; i < tpl.length; i++) {
    s += tpl[i];
    if (i < vals.length) s += String(vals[i]);
  }
  return s.trim();
}

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

  const c = (n > 0 ? String.fromCharCode(buf[0]) : "").toLowerCase();
  return c === "y";
}

export type SafeExecHookOptions = {
  bun?: any; // optional specific Bun object to patch (for tests)
  cp?: Partial<typeof import("node:child_process")>;
  ask?: (q: string) => Promise<boolean>;
};

/** Patch a specific Bun.$ if not already patched */
function patchBunDollar(bun: any) {
  if (!bun || typeof bun.$ !== "function") return;
  if (PATCHED_BUNS.has(bun)) return;

  const orig$ = bun.$;
  ORIG_BUN_DOLLAR.set(bun, orig$);

  bun.$ = new Proxy(orig$, {
    apply(target, thisArg, argArray) {
      const [tpl, ...vals] = argArray as [TemplateStringsArray, ...unknown[]];
      const preview = interpolate(tpl as any, vals);
      const run = async () => {
        const ok = await ASK(`[SAFE] About to run: ${preview}`);
        if (!ok) {
          // Denied: return an object-like result so callers can inspect exitCode/text()
          return {
            exitCode: 0,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            text: async () => "",
          };
        }
        return Reflect.apply(target as any, thisArg, argArray);
      };
      return (async () => run())();
    }
  });

  PATCHED_BUNS.add(bun);
}

/** Patch child_process exec/execFile once (uses sync confirm) */
function patchChildProcess(cp: any) {
  if (CP_INSTALLED) return;
  if (!cp) cp = require("node:child_process") as typeof import("node:child_process");

  if (cp && typeof cp.exec === "function") {
    ORIG_EXEC = cp.exec.bind(cp);
    cp.exec = function patchedExec(command: any, options?: any, callback?: any) {
      const preview = String(command ?? "").trim();
      if (!confirmSyncPreview(preview)) {
        const cb = (typeof options === "function" ? options
                  : typeof callback === "function" ? callback : null) as any;
        cb?.(null, "", "");
        return {} as any;
      }
      return ORIG_EXEC(command, options as any, callback as any);
    } as any;
  }

  if (cp && typeof cp.execFile === "function") {
    ORIG_EXECFILE = cp.execFile.bind(cp);
    cp.execFile = function patchedExecFile(file: any, args?: any, options?: any, callback?: any) {
      const preview = [file, ...(Array.isArray(args) ? args : [])]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (!confirmSyncPreview(preview)) {
        const cb = (typeof options === "function" ? options
                  : typeof callback === "function" ? callback : null) as any;
        cb?.(null, "", "");
        return {} as any;
      }
      return ORIG_EXECFILE(file, args as any, options as any, callback as any);
    } as any;
  }

  CP_INSTALLED = true;
}

/** Public: install hooks (idempotent; can update ASK and patch additional Bun objects) */
export function installSafeExecHook(opts?: SafeExecHookOptions): void {
  if (!shouldUseSafeMode()) return; // only active in safe mode

  if (opts?.ask) {
    ASK = opts.ask;
  } else {
    ASK = (q) => confirm(q); // reset to default each install unless provided
  }

  if (opts?.cp) {
    patchChildProcess(opts.cp);
  } else {
    patchChildProcess(undefined);
  }

  // patch specific bun first if provided
  if (opts?.bun) patchBunDollar(opts.bun);

  // also patch global Bun if present
  const globalBun: any = (globalThis as any).Bun;
  if (globalBun) patchBunDollar(globalBun);
}

/** For tests: restore original state */
export function __resetSafeExecHookForTests() {
  // Restore any Bun.$ we patched
  for (const [bun, orig] of ORIG_BUN_DOLLAR.entries()) {
    try { (bun as any).$ = orig; } catch {}
  }
  ORIG_BUN_DOLLAR.clear();

  // Allow re-patching later
  PATCHED_BUNS = new WeakSet<any>();

  // Restore child_process hooks if we installed them
  if (CP_INSTALLED) {
    try {
      const cp = require("node:child_process") as typeof import("node:child_process");
      if (ORIG_EXEC)      (cp as any).exec     = ORIG_EXEC;
      if (ORIG_EXECFILE)  (cp as any).execFile = ORIG_EXECFILE;
    } catch {}
  }
  CP_INSTALLED = false;
  ORIG_EXEC = null;
  ORIG_EXECFILE = null;

  // Reset ASK gate to default (interactive confirm)
  ASK = (q) => confirm(q);
}

