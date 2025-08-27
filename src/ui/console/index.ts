import * as fs from "fs";
import { findLastSessionPatch } from "../../lib/session-patch";
import { createFsm, Mode, isPrintableByte, toUtf8 } from "./fsm";
import { startTtySession, stopTtySession } from "./tty";

function trace(msg: string) {
  if (process.env.ORG_DEBUG === "1" || process.env.DEBUG === "1" || process.env.ORG_UI_TRACE === "1") {
    process.stderr.write(`[console-ui] ${msg}\n`);
  }
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
  // We run in raw/no-echo already; render a minimal y/N prompt
  process.stdout.write(`${question} [y/N] `);
  return await new Promise<boolean>((resolve) => {
    const onKey = (chunk: Buffer) => {
      const c = chunk.length ? chunk[0] : 0;
      // Accept y/Y for yes; ESC/CR/LF/N/n default to No
      if (c === 0x79 || c === 0x59) { // 'y' | 'Y'
        process.stdin.off("data", onKey);
        process.stdout.write("\n");
        resolve(true);
        return;
      }
      if (c === 0x1b || c === 0x0d || c === 0x0a || c === 0x6e || c === 0x4e) { // ESC|CR|LF|'n'|'N'
        process.stdin.off("data", onKey);
        process.stdout.write("\n");
        resolve(false);
        return;
      }
    };
    process.stdin.on("data", onKey);
  });
}

/**
 * Single key loop + FSM. We keep the terminal in raw + no-echo for the
 * entire session; only INTERJECT state performs live echo.
 */
export async function launchConsoleUI(_argv: string[]): Promise<number> {
  trace("start");
  startTtySession();

  const fsm = createFsm();
  let exitCode = 0;

  const finish = (code = 0) => {
    if (fsm.mode !== Mode.EXITING) {
      trace(`exit code=${code}`);
      stopTtySession();
      process.stdin.setEncoding("binary"); // no-op but keeps TypeScript happy
      fsm.mode = Mode.EXITING;
    }
  };

  function enterInterject(seed?: Buffer) {
    fsm.mode = Mode.INTERJECT;
    fsm.buf.length = 0;
    if (seed && seed.length) {
      fsm.buf.push(seed);
      // We live-echo only now (terminal echo is off globally)
      process.stdout.write(Buffer.from([ ...seed ]).toString("utf8"));
    }
  }

  function cancelInterject() {
    // User cancelled with ESC
    process.stdout.write("\n");
    fsm.mode = Mode.IDLE;
    fsm.buf.length = 0;
  }

  function submitInterject() {
    // We assume your InputController is reading stdin; we do *not*
    // reprint the entire line (no double echo). Just newline and return to IDLE.
    process.stdout.write("\n");
    fsm.mode = Mode.IDLE;
    fsm.buf.length = 0;
  }

  async function handleTopLevelEsc(): Promise<void> {
    const patch = hasNonEmptyPatch(process.cwd());
    trace(`ESC at IDLE: patch=${patch ?? "<none>"}`);
    if (!patch) {
      // No patch => graceful exit
      exitCode = 0;
      finish(exitCode);
      return;
    }
    // Ask before applying; honor only on 'y'
    const yes = await promptYesNo("Apply this patch?");
    // The actual apply operation is handled by your finalize path;
    // UI just returns 0 to allow shutdown.
    exitCode = 0;
    finish(exitCode);
  }

  await new Promise<void>((resolve) => {
    const onKey = async (chunk: Buffer) => {
      if (fsm.mode === Mode.EXITING) return;

      // Always look at the first byte (we treat multibyte as printable bytes; the buf joins)
      const b0 = chunk.length ? chunk[0] : 0;

      switch (fsm.mode) {
        case Mode.IDLE: {
          if (b0 === 0x1b) { // ESC
            await handleTopLevelEsc();
            resolve();
            return;
          }
          if (b0 === 0x69) { // 'i' -> explicit interject
            enterInterject();
            return;
          }
          // first printable char opens interject seeded with the char
          if (isPrintableByte(b0)) {
            enterInterject(chunk);
            return;
          }
          // Ignore everything else in IDLE (Ctrl/Cmd or stray CR/LF)
          return;
        }

        case Mode.INTERJECT: {
          // ESC cancels the interject
          if (b0 === 0x1b) { // ESC
            cancelInterject();
            return;
          }
          // ENTER submits the line
          if (b0 === 0x0d || b0 === 0x0a) { // CR|LF
            submitInterject();
            return;
          }
          // Backspace
          if (b0 === 0x7f) {
            if (fsm.buf.length) {
              const last = fsm.buf[fsm.buf.length - 1];
              if (last.length > 0) {
                fsm.buf[fsm.buf.length - 1] = last.subarray(0, last.length - 1);
                process.stdout.write("\b \b");
              }
              if (fsm.buf[fsm.buf.length - 1].length === 0) fsm.buf.pop();
            }
            return;
          }
          // Normal printable: accumulate + live echo
          if (isPrintableByte(b0)) {
            fsm.buf.push(chunk);
            process.stdout.write(chunk.toString("utf8"));
            return;
          }
          return;
        }

        default:
          return;
      }
    };

    process.stdin.on("data", onKey);

    const done = () => {
      process.stdin.off("data", onKey);
      resolve();
    };

    // If we ever transition to EXITING programmatically, finish the promise
    const checkExitInterval = setInterval(() => {
      if (fsm.mode === Mode.EXITING) {
        clearInterval(checkExitInterval);
        done();
      }
    }, 50);
  });

  stopTtySession();
  trace(`exit code=${exitCode}`);
  return exitCode;
}
