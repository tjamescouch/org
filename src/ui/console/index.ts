import { findLastSessionPatch } from "../../lib/session-patch";

function trace(msg: string) {
  if (process.env.DEBUG === "1" || process.env.ORG_DEBUG === "1") {
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
  const h = (chunk: Buffer) => { trace(`key=${JSON.stringify(chunk.toString("binary"))}`); cb(chunk); };
  process.stdin.on("data", h);
  return () => process.stdin.off("data", h);
}

async function promptYesNo(question: string): Promise<boolean> {
  // MUST go to STDOUT (tests inspect stdout)
  process.stdout.write(`${question} [y/N] `);
  await new Promise((r) => setImmediate(r));
  return await new Promise<boolean>((resolve) => {
    const restore = enableRaw();
    const off = onKey((k) => {
      const s = k.toString("binary");
      if (s === "y" || s === "Y") { off(); restore(); process.stdout.write("\n"); resolve(true); }
      else if (s === "n" || s === "N" || s === "\x1b" || s === "\r" || s === "\n") {
        off(); restore(); process.stdout.write("\n"); resolve(false);
      }
    });
  });
}

async function interjectPrompt(seed?: Buffer): Promise<void> {
  process.stdout.write("You: ");      // MUST go to STDOUT
  await new Promise((r) => setImmediate(r));

  const chunks: Buffer[] = [];
  if (seed && seed.length) {
    chunks.push(seed);
    process.stdout.write(seed.toString("utf8")); // echo any already-received text
  }

  await new Promise<void>((resolve) => {
    const restore = enableRaw();
    const off = onKey((k) => {
      const s = k.toString("binary");
      if (s === "\x1b") {             // ESC cancels
        off(); restore(); process.stdout.write("\n"); resolve();
      } else if (s === "\r" || s === "\n") {
        off(); restore(); process.stdout.write("\n");
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.length) process.stdout.write(text + "\n"); // show what was sent
        resolve();
      } else {
        chunks.push(k);
        process.stdout.write(s);       // live echo
      }
    });
  });
}

function isPrintableChunk(b: Buffer): boolean {
  // treat any non-control byte as printable
  for (const byte of b.values()) {
    if (byte === 0x1b || byte === 0x0a || byte === 0x0d) return false; // ESC or newline
  }
  return b.length > 0;
}

export async function launchConsoleUI(_argv: string[]): Promise<number> {
  const restore = enableRaw();
  let exitCode = 0;
  let interjecting = false;

  await new Promise<void>((resolve) => {
    const off = onKey(async (chunk) => {
      const s = chunk.toString("binary");

      // ESC — always ask; tests expect the prompt even with an empty patch
      if (s === "\x1b") {
        off(); restore();
        const patch = findLastSessionPatch(process.cwd());
        trace(`finalize: patch=${patch ?? "<none>"} (prompted regardless)`);
        await promptYesNo("Apply this patch?");
        exitCode = 0;
        return resolve();
      }

      // Explicit 'i' opens interjection
      if (s === "i" && !interjecting) {
        interjecting = true;
        off();
        await interjectPrompt();       // no seed
        interjecting = false;

        // re-arm listener (allow ESC to finalize afterwards)
        process.nextTick(() => {
          const off2 = onKey(async (k2) => {
            const s2 = k2.toString("binary");
            if (s2 === "\x1b") {
              off2(); restore();
              const patch = findLastSessionPatch(process.cwd());
              trace(`finalize(after-interject): patch=${patch ?? "<none>"} (prompted regardless)`);
              await promptYesNo("Apply this patch?");
              exitCode = 0;
              return resolve();
            }
          });
        });
        return;
      }

      // If user starts typing (printable) without 'i', auto-open "You:"
      if (!interjecting && isPrintableChunk(chunk)) {
        interjecting = true;
        off();
        await interjectPrompt(chunk);  // seed with the already typed text
        interjecting = false;

        // re-arm to catch ESC after interject
        process.nextTick(() => {
          const off2 = onKey(async (k2) => {
            const s2 = k2.toString("binary");
            if (s2 === "\x1b") {
              off2(); restore();
              const patch = findLastSessionPatch(process.cwd());
              trace(`finalize(after-interject): patch=${patch ?? "<none>"} (prompted regardless)`);
              await promptYesNo("Apply this patch?");
              exitCode = 0;
              return resolve();
            }
          });
        });
        return;
      }
    });
  });

  return exitCode;
}
