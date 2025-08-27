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
  const handler = (chunk: Buffer) => {
    trace(`key=${JSON.stringify(chunk.toString("binary"))}`);
    cb(chunk);
  };
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

function printable(b: Buffer): boolean {
  for (const byte of b.values()) {
    // block ESC / CR / LF; handle Backspace separately
    if (byte === 0x1b || byte === 0x0a || byte === 0x0d) return false;
  }
  return b.length > 0;
}

function hasNonEmptyPatch(cwd: string): string | null {
  const p = findLastSessionPatch(cwd);
  if (!p) return null;
  try { const st = fs.statSync(p); return st.isFile() && st.size > 0 ? p : null; }
  catch { return null; }
}

async function interjectPrompt(seed?: Buffer): Promise<void> {
  // We do NOT print our own "You:" label; the caller/scheduler already printed it.

  await new Promise((r) => setImmediate(r));
  const chunks: Buffer[] = [];
  if (seed?.length) {
    // Echo the seeded byte(s) and keep them
    process.stdout.write(seed.toString("utf8"));
    chunks.push(seed);
  }

  await new Promise<void>((resolve) => {
    const restore = enableRaw();
    const off = onKey((k) => {
      const s = k.toString("binary");

      // ESC cancels interjection
      if (s === "\x1b") {
        off(); restore();
        process.stdout.write("\n");
        return resolve();
      }

      // Enter submits (do not re-echo the whole line)
      if (s === "\r" || s === "\n") {
        off(); restore();
        process.stdout.write("\n");
        return resolve();
      }

      // Backspace (DEL)
      if (k.length === 1 && k[0] === 0x7f) {
        if (chunks.length) {
          const last = chunks[chunks.length - 1];
          if (last.length > 0) {
            // Trim one byte (UTF-8: acceptable for simple ASCII prompts)
            chunks[chunks.length - 1] = last.subarray(0, last.length - 1);
            // Erase one char visually
            process.stdout.write("\b \b");
          }
          if (chunks[chunks.length - 1].length === 0) chunks.pop();
        }
        return;
      }

      // Regular printable
      if (printable(k)) {
        chunks.push(k);
        process.stdout.write(k.toString("utf8")); // live echo
      }
    });
  });
}

export async function launchConsoleUI(_argv: string[]): Promise<number> {
  trace("start");
  const restore = enableRaw();
  let exitCode = 0;
  let interjecting = false;

  await new Promise<void>((resolve) => {
    const off = onKey(async (chunk) => {
      const s = chunk.toString("binary");

      // ESC top-level: prompt only if a non-empty patch exists; else exit
      if (s === "\x1b") {
        off(); restore();
        const patch = hasNonEmptyPatch(process.cwd());
        trace(`esc: patch=${patch ?? "<none>"} -> ${patch ? "prompt" : "exit"}`);
        if (!patch) { exitCode = 0; return resolve(); }
        await promptYesNo("Apply this patch?");
        exitCode = 0; return resolve();
      }

      // Explicit 'i' opens the interject prompt
      if (s === "i" && !interjecting) {
        interjecting = true; off();
        await interjectPrompt(); interjecting = false;

        // After interject, watch ESC for finalize prompt
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

      // Typing text without 'i' => open interject prompt seeded with that first char
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
