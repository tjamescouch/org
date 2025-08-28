import * as fs from "fs";
import { spawnSync } from "child_process";
import { findLastSessionPatch } from "../../lib/session-patch";

function trace(msg: string) {
  //if (process.env.ORG_DEBUG === "1" || process.env.DEBUG === "1") {
  //  process.stderr.write(`[console-ui] ${msg}\n`);
  //}
}

/**
 * Put the terminal into a known good state for key-by-key input:
 *  - raw mode on
 *  - echo off (via stty), so the terminal itself does NOT echo
 * Returns a restore() and a flag telling the caller whether it's safe to
 * do live-echo (i.e., we actually turned echo off).
 */
function enableRaw(): { restore: () => void; liveEcho: boolean } {
  const stdin = process.stdin as any;
  const tty = !!stdin.isTTY;

  let usedSetRaw = false;
  let turnedEchoOff = false;

  if (tty) {
    // 1) Try raw mode
    if (!stdin.isRaw) {
      try {
        stdin.setRawMode(true);
        usedSetRaw = true;
      } catch { /* ignore */ }
    }

    // 2) Forcibly turn echo off (belt-and-suspenders)
    try {
      // stdio: inherit for stdin so stty operates on the controlling TTY
      spawnSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
      turnedEchoOff = true;
    } catch { /* ignore */ }
  }

  process.stdin.resume();

  const restore = () => {
    if (tty) {
      // Re-enable echo if we turned it off
      if (turnedEchoOff) {
        try {
          spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
        } catch { /* ignore */ }
      }
      // Turn raw off if we turned it on
      if (usedSetRaw) {
        try { stdin.setRawMode(false); } catch { /* ignore */ }
      }
    }
  };

  // If we disabled terminal echo, the UI should perform live echo.
  const liveEcho = false;//turnedEchoOff || usedSetRaw;
  return { restore, liveEcho };
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
    const { restore, liveEcho } = enableRaw();
    const off = onKey((k) => {
      const s = k.toString("binary");
      // Do NOT live echo here; just read y/n/enter/esc
      if (s === "y" || s === "Y") { off(); restore(); process.stdout.write("\n"); resolve(true); }
      else if (s === "n" || s === "N" || s === "\x1b" || s === "\r" || s === "\n") {
        off(); restore(); process.stdout.write("\n"); resolve(false);
      }
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
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0 ? p : null;
  } catch {
    return null;
  }
}

async function interjectPrompt(seed?: Buffer): Promise<void> {
  // The scheduler printed the visible "You:" prompt already; don't print another here.
  await new Promise((r) => setImmediate(r));

  const chunks: Buffer[] = [];
  const { restore, liveEcho } = enableRaw();

  // Seed: echo it only if we control echo; otherwise avoid duplication
  if (seed?.length) {
    chunks.push(seed);
    if (liveEcho) process.stdout.write(seed.toString("utf8"));
  }

  await new Promise<void>((resolve) => {
    const off = onKey((k) => {
      const s = k.toString("binary");

      // ESC cancels interjection
      if (s === "\x1b") {
        off(); restore(); process.stdout.write("\n"); return resolve();
      }

      // Enter submits (do not re-echo the whole line)
      if (s === "\r" || s === "\n") {
        off(); restore(); process.stdout.write("\n"); return resolve();
      }

      // Backspace (DEL)
      if (k.length === 1 && k[0] === 0x7f) {
        if (chunks.length) {
          // Trim one byte in the last chunk (ASCII-friendly)
          const last = chunks[chunks.length - 1];
          if (last.length > 0) {
            chunks[chunks.length - 1] = last.subarray(0, last.length - 1);
            if (liveEcho) process.stdout.write("\b \b");
          }
          if (chunks[chunks.length - 1].length === 0) chunks.pop();
        }
        return;
      }

      // Regular printable
      if (printable(k)) {
        chunks.push(k);
        if (liveEcho) process.stdout.write(k.toString("utf8")); // echo ONLY if we disabled terminal echo
      }
    });
  });
}

export async function launchConsoleUI(_argv: string[]): Promise<number> {
  trace("start");
  // Put the terminal in a deterministic state up-front (helps when ESC exits immediately).
  const pre = enableRaw();
  pre.restore(); // just to normalize if prior state was messy

  let exitCode = 0;
  let interjecting = false;

  await new Promise<void>((resolve) => {
    const off = onKey(async (chunk) => {
      const s = chunk.toString("binary");

      // ESC top-level: prompt only if a non-empty patch exists; else exit
      if (s === "\x1b") {
        off();
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
              off2();
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
              off2();
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
