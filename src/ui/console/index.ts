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

function onKey(cb: (key: Buffer) => void): () => void {
  const h = (chunk: Buffer) => { trace(`key=${JSON.stringify(chunk.toString("binary"))}`); cb(chunk); };
  process.stdin.on("data", h);
  return () => process.stdin.off("data", h);
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

async function interjectPrompt(): Promise<void> {
  process.stdout.write("You: ");
  await new Promise((r) => setImmediate(r));
  const chunks: Buffer[] = [];
  return await new Promise<void>((resolve) => {
    const restore = enableRaw();
    const off = onKey((k) => {
      const s = k.toString("binary");
      if (s === "\x1b") { off(); restore(); process.stdout.write("\n"); resolve(); }
      else if (s === "\r" || s === "\n") {
        off(); restore(); process.stdout.write("\n");
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.length) process.stdout.write(text + "\n");
        resolve();
      } else {
        chunks.push(k);
        process.stdout.write(s);
      }
    });
  });
}

export async function launchConsoleUI(_argv: string[]): Promise<number> {
  const restore = enableRaw();
  let exitCode = 0;

  await new Promise<void>((resolve) => {
    const off = onKey(async (k) => {
      const s = k.toString("binary");

      if (s === "\x1b") {
        off(); restore();
        const patch = findLastSessionPatch(process.cwd());
        trace(`finalize: patch=${patch ?? "<none>"}`);
        if (!patch) { exitCode = 0; return resolve(); }
        const ok = await promptYesNo("Apply this patch?");
        trace(`finalize: user=${ok ? "y" : "n"}`);
        exitCode = 0;
        return resolve();
      }

      if (s === "i") {
        off();
        await interjectPrompt();
        process.nextTick(() => {
          const off2 = onKey(async (k2) => {
            const s2 = k2.toString("binary");
            if (s2 === "\x1b") {
              off2(); restore();
              const patch = findLastSessionPatch(process.cwd());
              trace(`finalize(after-interject): patch=${patch ?? "<none>"}`);
              if (!patch) { exitCode = 0; return resolve(); }
              const ok = await promptYesNo("Apply this patch?");
              trace(`finalize(after-interject): user=${ok ? "y" : "n"}`);
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
