// src/tools/vimdiff.ts
import path from "node:path";
import { promises as fs } from "node:fs";
import { type ChildProcess } from "node:child_process";
import { spawnInCleanEnvironment } from "../utils/spawn-clean";
import { pauseStdin, resumeStdin } from "../input/utils";
import { Controller } from "../input/controller";
import { beginTtyHandoff, endTtyHandoff } from "../input/tty-handoff";

type Args = { left: string; right: string; cwd?: string };


type VimdiffResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  cmd: string;
};

export async function runVimdiff(args: Args): Promise<VimdiffResult> {
  const cwd = args.cwd ?? process.cwd();

  // Ensure files exist
  await fs.stat(path.resolve(cwd, args.left));
  await fs.stat(path.resolve(cwd, args.right));

  // Make sure our app isn't holding the TTY in raw/paused mode
  //try { pauseStdin?.(); } catch { }

  const wasRaw = (process.stdin as any)?.isTTY && (process.stdin as any).isRaw === true;
  if ((process.stdin as any)?.isTTY && (process.stdin as any).setRawMode) {
    try { (process.stdin as any).setRawMode(false); } catch { }
  }

  Controller.disableKeys();
  const handoff = beginTtyHandoff();
  try {
    // Inherit TTY so the user controls vim
    const spawned = spawnInCleanEnvironment(
      "/usr/bin/vim",
      ["-d", args.left, args.right],
      { cwd, stdio: "inherit", debugLabel: "vimdiff", shell: false }
    );

    const child: ChildProcess =
      (spawned && (spawned.child as ChildProcess)) ||
      (spawned && (spawned.proc as ChildProcess)) ||
      (spawned as ChildProcess);

    if (!child || typeof (child as any).on !== "function") {
      // Fallback if wrapper didn't return a process
      throw new Error("[vimdiff] spawnInCleanEnvironment did not return a child process.");
    }

    //return await waitForChild(child, { wasRaw });
    const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? 0)));
    Controller.enableKeys();
    return { ok: code === 0, exit_code: code, cmd: '', stderr: '', stdout: '' };
  } finally {
    endTtyHandoff(handoff);
  }
}

async function waitForChild(child: ChildProcess, opts: { wasRaw: boolean }): Promise<VimdiffResult> {
  const code: number = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (c: number | null) => resolve(c ?? 0));
  });

  // restore input handling
  if ((process.stdin as any)?.isTTY && (process.stdin as any).setRawMode) {
    try { (process.stdin as any).setRawMode(opts.wasRaw); } catch { }
  }
  try { resumeStdin?.(); } catch { }

  return {
    ok: code === 0,
    stdout: "",
    stderr: "",
    exit_code: code ?? 0,
    cmd: "vim -d <left> <right>",
  };
}


export const VIMDIFF_TOOL_DEF = {
  type: "function",
  function: {
    name: "vimdiff",
    description:
      "Launch an interactive vimdiff session comparing two files. " +
      "Use for human-in-the-loop review. The current working directory is respected. " +
      "Returns JSON: { exitCode } after vim exits.",
    parameters: {
      type: "object",
      properties: {
        left: {
          type: "string",
          description:
            "Path to the LEFT file (typically the original file). Relative paths are resolved from the current working directory.",
        },
        right: {
          type: "string",
          description:
            "Path to the RIGHT file (typically the candidate/temporary file). Relative paths are resolved from the current working directory.",
        },
        cwd: {
          type: "string",
          description:
            "(optional) Working directory for vimdiff. If omitted, use the process CWD.",
        },
      },
      required: ["left", "right"],
      additionalProperties: false,
    },
  },
} as const;
