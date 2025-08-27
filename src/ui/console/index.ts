// src/ui/console/index.ts
import * as fs from "fs";
import { findLastSessionPatch } from "../../lib/session-patch";

function trace(msg: string) {
  if (process.env.ORG_DEBUG === "1" || process.env.DEBUG === "1") {
    process.stderr.write(`[console-ui] ${msg}\n`);
  }
}

function enableRaw(): () => void {
  const stdin = process.stdin;
  const wasRaw = Boolean(stdin.isTTY && (stdin as any).isRaw);
  if (stdin.isTTY && !wasRaw) stdin.setRawMode?.(true);
  stdin.resume();
  return () => { if (stdin.isTTY && !wasRaw) stdin.setRawMode?.(false); };
}

function onKey(cb: (chunk: Buffer) => void): () => void {
  const handler = (chunk: Buffer) => { trace(`key=${JSON.stringify(chunk.toString("binary"))}`); cb(chunk); };
  process.stdin.on("data", handler);
  return () => process.stdin.off("data", handler);
}

async function promptYesNo(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  await new Promise((r) => setImmediate(r));
  return await new Promise<boolean>((resolve) => {
    const restore = enableRaw();
    const off = onKey((k) => {
      const s = k.toString("binary");
      if (s === "y" || s === "Y") { off(); restore(); process.stdout.write("\n"); resolve(true); }
      else if (s === "n" || s === "N" || s === "\x1b" || s === "\r" || s === "\n") { off(); restore(); process.stdout.write("\n"); resolve(false); }
    });
  });
}

async function interjectPrompt(seed?: Buffer): Promise<void> {
  process.stdout.write("You: ");                // visible prompt (stdout)
  await new Promise((r) => setImmediate(r));

  const chunks: Buffer[] = [];
  if (seed?.length) chunks.push(seed);         // do NOT echo seed; avoid double-echo from tty

  await new Promise<void>((resolve) => {
    const restore = enableRaw();
    const off = onKey((k) => {
      const s = k.toString("binary");
      if (s === "\x1b") {                       // ESC -> cancel
        off(); restore(); process.stdout.write("\n"); resolve();
      } else if (s === "\r" || s === "\n") {    // Enter -> submit; echo once
        off(); restore(); process.stdout.write("\n");
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.length) process.stdout.write(text + "\n");
        resolve();
      } else {
        chunks.push(k);                         // collect only; no per-char echo
      }
    });
  });
}

function printable(b: Buffer): boolean {
  for (const byte of b.values()) {
    if (byte === 0x1b || byte === 0x0a || byte === 0x0d) return false; // ESC/CR/LF
  }
  return b.length > 0;
}

function hasNonEmptyPatch(cwd: string): string | null {
  const p = findLastSessionPatch(cwd);
  if (!p) return null;
  try { const st = fs.statSync(p); return st.isFile() && st.size > 0 ? p : null; }
  catch { return null; }
}

export async function launchConsoleUI(_argv: string[]): Promise<number> {
  trace("start");
  const restore = enableRaw();
  let exitCode = 0;
  let interjecting = false;

  await new Promise<void>((resolve) => {
    const off = onKey(async (chunk) => {
      const s = chunk.toString("binary");

      // ESC: prompt only if there is a non-empty patch; else exit immediately
      if (s === "\x1b") {
        off(); restore();
        const patch = hasNonEmptyPatch(process.cwd());
        trace(`esc: patch=${patch ?? "<none>"} -> ${patch ? "prompt" : "exit"}`);
        if (!patch) { exitCode = 0; return resolve(); }
        await promptYesNo("Apply this patch?");
        exitCode = 0; return resolve();
      }

      // Explicit 'i' opens interject
      if (s === "i" && !interjecting) {
        interjecting = true; off();
        await interjectPrompt(); interjecting = false;

        process.nextTick(() => {
          const off2 = onKey(async (k2) => {
            const s2 = k2.toString("binary");
            if (s2 === "\x1b") {
              off2(); restore();
              const patch = hasNonEmptyPatch(process.cwd());
              trace(`esc(after-interject): patch=${patch ?? "<none>"} -> ${patch ? "prompt" : "exit"}`);
              if (!patch) { exitCode = 0; return resolve(); }
              await promptYesNo("Apply this patch?"); exitCode = 0; return resolve();
            }
          });
        });
        return;
      }

      // Typed text w/o 'i' → open interject
      if (!interjecting && printable(chunk)) {
        interjecting = true; off();
        await interjectPrompt(chunk); interjecting = false;

        process.nextTick(() => {
          const off2 = onKey(async (k2) => {
            const s2 = k2.toString("binary");
            if (s2 === "\x1b") {
              off2(); restore();
              const patch = hasNonEmptyPatch(process.cwd());
              trace(`esc(after-interject): patch=${patch ?? "<none>"} -> ${patch ? "prompt" : "exit"}`);
              if (!patch) { exitCode = 0; return resolve(); }
              await promptYesNo("Apply this patch?"); exitCode = 0; return resolve();
            }
          });
        });
        return;
      }
    });
  });

  trace(`exit code=${exitCode}`);
  return exitCode;
}
