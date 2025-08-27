// src/ui/console/index.ts
import * as fs from "fs";
import { findLastSessionPatch } from "../../lib/session-patch";

/* =========
 * Tracing
 * ========= */
function trace(msg: string) {
  if (process.env.ORG_DEBUG === "1" || process.env.DEBUG === "1") {
    process.stderr.write(`[console-ui] ${msg}\n`);
  }
}

/* =========
 * TTY helpers
 * ========= */
function enableRaw(): () => void {
  const stdin = process.stdin as any;
  const canRaw = !!stdin.isTTY && typeof stdin.setRawMode === "function";
  const wasRaw = canRaw ? !!stdin.isRaw : false;

  if (canRaw && !wasRaw) stdin.setRawMode(true);
  process.stdin.resume();

  // important: only restore if *we* changed it
  return () => {
    if (canRaw && !wasRaw) stdin.setRawMode(false);
  };
}

function onKey(cb: (chunk: Buffer) => void): () => void {
  const handler = (chunk: Buffer) => {
    // keep logging tiny & optional to avoid flooding tests
    trace(`key=${JSON.stringify(chunk.toString("binary"))}`);
    cb(chunk);
  };
  process.stdin.on("data", handler);
  return () => process.stdin.off("data", handler);
}

/* =========
 * Small utils
 * ========= */
function printable(b: Buffer): boolean {
  // treat anything containing control bytes (ESC, CR, LF) as non-printable
  for (const byte of b.values()) {
    if (byte === 0x1b || byte === 0x0a || byte === 0x0d) return false;
  }
  return b.length > 0;
}

function hasNonEmptyPatch(cwd: string): string | null {
  const p = findLastSessionPatch(cwd);
  if (!p) return null;
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0 ? p : null;
  } catch {
    return null;
  }
}

/* =========
 * Prompts
 * ========= */
async function promptYesNo(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  await new Promise((r) => setImmediate(r));

  return await new Promise<boolean>((resolve) => {
    const restore = enableRaw();
    const off = onKey((k) => {
      const s = k.toString("binary");
      // y/Y => yes; anything else (n/N/enter/esc) => no
      if (s === "y" || s === "Y") {
        off(); restore(); process.stdout.write("\n"); resolve(true);
      } else if (s === "n" || s === "N" || s === "\x1b" || s === "\r" || s === "\n") {
        off(); restore(); process.stdout.write("\n"); resolve(false);
      } else if (s === "\x03") { // Ctrl-C inside prompt -> treat like "no" and bubble up
        off(); restore(); process.stdout.write("\n"); resolve(false);
      }
    });
  });
}

async function interjectPrompt(seed?: Buffer): Promise<void> {
  // visible prompt; we will not echo per-char to avoid duplicate echo
  process.stdout.write("You: ");
  await new Promise((r) => setImmediate(r));

  const chunks: Buffer[] = [];
  if (seed?.length) chunks.push(seed); // do NOT echo seed

  await new Promise<void>((resolve) => {
    const restore = enableRaw();
    const off = onKey((k) => {
      const s = k.toString("binary");

      if (s === "\x1b") {                // ESC → cancel, stop editing line
        off(); restore(); process.stdout.write("\n"); resolve();
        return;
      }
      if (s === "\x03") {                // Ctrl-C → propagate cancel to caller
        off(); restore(); process.stdout.write("\n"); resolve();
        return;
      }
      if (s === "\r" || s === "\n") {    // Enter → submit once
        off(); restore(); process.stdout.write("\n");
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.length) process.stdout.write(text + "\n");
        resolve();
        return;
      }
      if (s === "\x7f") {                // Backspace
        if (chunks.length) chunks.pop();
        return;
      }
      // collect only; no per-char echo to avoid duplicate "local echo"
      chunks.push(k);
    });
  });
}

/* =========
 * UI entry
 * ========= */
export async function launchConsoleUI(_argv: string[]): Promise<number> {
  trace("start");

  // make whole UI raw so ESC / Ctrl-C are visible immediately
  const restoreOuter = enableRaw();
  let exitCode = 0;
  let interjecting = false;
  let resolved = false;

  // Support Ctrl-C from the OS level as a final escape hatch.
  const onSigInt = () => {
    if (resolved) return;
    resolved = true;
    exitCode = 130; // common convention
    try { restoreOuter(); } catch {}
  };
  process.once("SIGINT", onSigInt);

  await new Promise<void>((resolve) => {
    const resumeMainKeys = () => {
      // (re)attach main key loop
      const off = onKey(async (chunk) => {
        const s = chunk.toString("binary");

        // Ctrl-C anywhere -> exit immediately
        if (s === "\x03") {
          off(); process.removeListener("SIGINT", onSigInt);
          try { restoreOuter(); } catch {}
          exitCode = 130; resolved = true; return resolve();
        }

        // ESC -> prompt only if a patch exists; otherwise exit
        if (s === "\x1b") {
          off();
          const patch = hasNonEmptyPatch(process.cwd());
          trace(`esc: patch=${patch ?? "<none>"} -> ${patch ? "prompt" : "exit"}`);
          if (!patch) {
            process.removeListener("SIGINT", onSigInt);
            try { restoreOuter(); } catch {}
            exitCode = 0; resolved = true; return resolve();
          }
          await promptYesNo("Apply this patch?");
          process.removeListener("SIGINT", onSigInt);
          try { restoreOuter(); } catch {}
          exitCode = 0; resolved = true; return resolve();
        }

        // explicit 'i' opens prompt
        if (s === "i" && !interjecting) {
          interjecting = true; off();
          await interjectPrompt(); interjecting = false;
          // go back to main loop
          process.nextTick(resumeMainKeys);
          return;
        }

        // typed text without 'i' -> open prompt seeded with first char
        if (!interjecting && printable(chunk)) {
          interjecting = true; off();
          await interjectPrompt(chunk); interjecting = false;
          process.nextTick(resumeMainKeys);
          return;
        }
      });
    };

    resumeMainKeys();
  });

  trace(`exit code=${exitCode}`);
  return exitCode;
}
