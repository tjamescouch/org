// src/ui/console/index.ts
import * as fs from "fs";
import { findLastSessionPatch } from "../../lib/session-patch";

function trace(msg: string) {
  if (process.env.ORG_DEBUG === "1" || process.env.DEBUG === "1") {
    process.stderr.write(`[console-ui] ${msg}\n`);
  }
}

function enableRaw(): () => void {
  const stdin = process.stdin as any;
  const canRaw = !!stdin.isTTY && typeof stdin.setRawMode === "function";
  const wasRaw = canRaw ? !!stdin.isRaw : false;

  if (canRaw && !wasRaw) stdin.setRawMode(true);
  process.stdin.resume();

  return () => {
    if (canRaw && !wasRaw) stdin.setRawMode(false);
  };
}

function onKey(cb: (chunk: Buffer) => void): () => void {
  const handler = (chunk: Buffer) => {
    trace(`key=${JSON.stringify(chunk.toString("binary"))}`);
    cb(chunk);
  };
  process.stdin.on("data", handler);
  return () => process.stdin.off("data", handler);
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
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0 ? p : null;
  } catch {
    return null;
  }
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
      else if (s === "\x03") { off(); restore(); process.stdout.write("\n"); resolve(false); } // Ctrl-C
    });
  });
}

async function interjectPrompt(seed?: Buffer): Promise<void> {
  // Show prompt and live-echo the line we’re building.
  process.stdout.write("You: ");
  await new Promise((r) => setImmediate(r));

  const chunks: Buffer[] = [];
  const restore = enableRaw();

  // If we were seeded (typed before we opened the editor), echo it now.
  if (seed?.length) {
    chunks.push(seed);
    process.stdout.write(seed.toString("utf8"));
  }

  await new Promise<void>((resolve) => {
    const off = onKey((k) => {
      const s = k.toString("binary");

      if (s === "\x03") { // Ctrl-C
        off(); restore(); process.stdout.write("\n"); resolve(); return;
      }
      if (s === "\x1b") { // ESC cancels
        off(); restore(); process.stdout.write("\n"); resolve(); return;
      }
      if (s === "\r" || s === "\n") { // submit
        off(); restore(); process.stdout.write("\n");
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.length) process.stdout.write(text + "\n");
        resolve(); return;
      }
      if (s === "\x7f" || s === "\b") { // backspace: pop and erase one char visually
        if (chunks.length) {
          const last = chunks.pop()!;
          // last may be multi-byte; for simplicity, treat byte-by-byte
          // remove one byte and put back the remainder (rarely needed)
          const kept = last.subarray(0, Math.max(0, last.length - 1));
          if (kept.length) chunks.push(kept);
          // visually erase one cell
          process.stdout.write("\b \b");
        }
        return;
      }
      // default: append + echo
      if (printable(k)) {
        chunks.push(k);
        process.stdout.write(k.toString("utf8"));
      }
    });
  });
}

export async function launchConsoleUI(_argv: string[]): Promise<number> {
  trace("start");
  const restoreOuter = enableRaw();
  let exitCode = 0;
  let interjecting = false;
  let resolved = false;

  const onSigInt = () => {
    if (resolved) return;
    resolved = true;
    exitCode = 130;
    try { restoreOuter(); } catch {}
  };
  process.once("SIGINT", onSigInt);

  await new Promise<void>((resolve) => {
    const resumeMainKeys = () => {
      const off = onKey(async (chunk) => {
        const s = chunk.toString("binary");

        if (s === "\x03") { // Ctrl-C anywhere
          off(); process.removeListener("SIGINT", onSigInt);
          try { restoreOuter(); } catch {}
          exitCode = 130; resolved = true; return resolve();
        }

        // ESC -> prompt apply only if a non-empty patch exists; else clean exit
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

        // 'i' opens editor
        if (s === "i" && !interjecting) {
          interjecting = true; off();
          await interjectPrompt(); interjecting = false;
          process.nextTick(resumeMainKeys);
          return;
        }

        // typed text without 'i' -> open editor seeded with first char
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
