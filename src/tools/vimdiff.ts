// src/tools/vimdiff.ts
import path from "node:path";
import { promises as fs } from "node:fs";
import { type ChildProcess } from "node:child_process";
import { spawnInCleanEnvironment } from "../utils/spawn-clean";
import { pauseStdin, resumeStdin } from "../input/utils";
import { Controller } from "../input/controller";

type Args = { left: string; right: string; cwd?: string };

export async function runVimdiff(args: Args) {
  const cwd = args.cwd ?? process.cwd();

  // Ensure files exist
  await fs.stat(path.resolve(cwd, args.left));
  await fs.stat(path.resolve(cwd, args.right));

  Controller.disableKeys();
  resumeStdin();

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

  const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? 0)));

  pauseStdin();
  Controller.enableKeys();
  return { exitCode: code };
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
