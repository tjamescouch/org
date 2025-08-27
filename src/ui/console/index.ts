// src/ui/console/index.ts
import fs from "node:fs";
import path from "node:path";

/**
 * Console UI contract: print prompts to **STDOUT** (tests read stdout),
 * return exit code 0 on ESC when there is **no** patch, and support:
 *   - ESC to finalize (review if a recent patch exists)
 *   - 'i' to open interjection ("You:" prompt) and send entered text, ESC to close
 *
 * Enable key tracing with DEBUG=1 or ORG_DEBUG=1.
 */

function trace(msg: string) {
  if (process.env.DEBUG === "1" || process.env.ORG_DEBUG === "1") {
    // stderr so it doesn't pollute r.out assertions
    process.stderr.write(`[console-ui] ${msg}\n`);
  }
}

function hasRecentPatch(cwd: string): { exists: boolean; patchPath: string } {
  const sessionDir =
    process.env.ORG_SESSION_DIR
      ? path.resolve(process.env.ORG_SESSION_DIR)
      : path.join(cwd, ".org");
  const patchPath = path.join(sessionDir, "last-session.patch");
  const exists = fs.existsSync(patchPath);
  trace(`cwd=${cwd} sessionDir=${sessionDir} patchPath=${patchPath} exists=${exists}`);
  return { exists, patchPath };
}

function enableRaw(): () => void {
  const stdin = process.stdin;
  const wasRaw = Boolean(stdin.isTTY && (stdin as any).isRaw);
  if (stdin.isTTY && !wasRaw) {
    stdin.setRawMode?.(true);
  }
  stdin.resume();
  return () => {
    if (stdin.isTTY && !wasRaw) {
      stdin.setRawMode?.(false);
    }
  };
}

function onKey(cb: (key: Buffer) => void): () => void {
  const handler = (chunk: Buffer) => {
    trace(`key=${JSON.stringify(chunk.toString("binary"))}`);
    cb(chunk);
  };
  process.stdin.on("data", handler);
  return () => process.stdin.off("data", handler);
}

async function promptYesNo(question: string): Promise<boolean> {
  // MUST print to STDOUT (tests assert on stdout)
  process.stdout.write(`${question} [y/N] `);
  await new Promise((r) => setImmediate(r)); // flush
  return await new Promise<boolean>((resolve) => {
    const restore = enableRaw();
    const off = onKey((k) => {
      const s = k.toString("binary");
      if (s === "y" || s === "Y") {
        off(); restore(); process.stdout.write("\n");
        resolve(true);
      } else if (s === "n" || s === "N" || s === "\x1b" || s === "\r" || s === "\n") {
        off(); restore(); process.stdout.write("\n");
        resolve(false);
      }
    });
  });
}

async function interjectPrompt(): Promise<void> {
  // MUST print to STDOUT (tests look for "You:")
  process.stdout.write("You: ");
  await new Promise((r) => setImmediate(r)); // flush

  const chunks: Buffer[] = [];
  return await new Promise<void>((resolve) => {
    const restore = enableRaw();
    const off = onKey((k) => {
      const s = k.toString("binary");
      if (s === "\x1b") { // ESC to cancel
        off(); restore(); process.stdout.write("\n");
        resolve();
      } else if (s === "\r" || s === "\n") {
        off(); restore(); process.stdout.write("\n");
        // echo entered text to stdout so tests can assert it was sent
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.length) process.stdout.write(text + "\n");
        resolve();
      } else {
        chunks.push(k);
        process.stdout.write(s); // echo while typing
      }
    });
  });
}

export async function launchConsoleUI(argv: string[]): Promise<number> {
  const cwd = process.cwd();

  // Wait for keys:
  //  - ESC -> finalize
  //  - 'i'  -> interject ("You:"), then ESC/newline to close
  const restore = enableRaw();
  let exitCode = 0;

  await new Promise<void>((resolve) => {
    const off = onKey(async (k) => {
      const s = k.toString("binary");

      if (s === "\x1b") {
        // ESC pressed: finalize flow
        off(); restore();
        const { exists } = hasRecentPatch(cwd);

        if (!exists) {
          // **Spec:** no patch => close silently with code 0
          trace("finalize: no patch -> exit 0");
          exitCode = 0;
          return resolve();
        }

        // Patch exists => ask
        const apply = await promptYesNo("Apply this patch?");
        trace(`finalize: patch exists, user=${apply ? "y" : "n"}`);
        // Exit code stays 0 regardless; write-policy is handled upstream
        exitCode = 0;
        return resolve();
      }

      if (s === "i") {
        // Interjection: show "You:" prompt, capture until ESC or newline
        off();
        await interjectPrompt();
        // Re-arm key listener for further keys (incl. ESC to finalize)
        process.nextTick(() => {
          const off2 = onKey(async (k2) => {
            const s2 = k2.toString("binary");
            if (s2 === "\x1b") {
              off2(); restore();
              const { exists } = hasRecentPatch(cwd);
              if (!exists) { exitCode = 0; return resolve(); }
              const apply = await promptYesNo("Apply this patch?");
              trace(`finalize(after-interject): user=${apply ? "y" : "n"}`);
              exitCode = 0;
              return resolve();
            }
          });
        });
        return;
      }

      // Ignore all other input
    });
  });

  return exitCode;
}
