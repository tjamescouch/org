// src/input/user-prompt.ts
import type { ReadStream, WriteStream } from "node:tty";
import { formatPromptLabel } from "../ui/prompt-label";
import { TtyScopes, defaultTtyScopes, type TtyIn } from "../input/tty-scopes";

/** Minimal readline-like interface for testability */
export interface RlLike {
  question(query: string): Promise<string>;
  close(): void;
}

interface RlFactoryOpts {
  input: ReadStream | NodeJS.ReadStream;
  output: WriteStream | NodeJS.WriteStream;
  terminal: boolean;
}
export type RlFactory = (opts: RlFactoryOpts) => RlLike;

function defaultRlFactory(opts: RlFactoryOpts): RlLike {
  // Lazy import to keep test doubles simple
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const readline = require("node:readline/promises") as typeof import("node:readline/promises");
  const rl = readline.createInterface({
    input: opts.input as NodeJS.ReadStream,
    output: opts.output as NodeJS.WriteStream,
    terminal: opts.terminal,
  });
  return {
    question: (q: string) => rl.question(q),
    close: () => rl.close(),
  };
}

interface AskUserLineOptions {
  username?: string;                 // default 'user'
  stdin?: NodeJS.ReadStream;         // default process.stdin
  stdout?: NodeJS.WriteStream;       // default process.stdout
  rlFactory?: RlFactory;             // injectable for tests
  scopes?: TtyScopes;                // injectable for tests
}

/**
 * Render a single user prompt (e.g., "You > ") and read one line of input.
 * Always runs under cooked TTY, restoring the previous mode on exit.
 */
export async function askUserLine(opts?: AskUserLineOptions): Promise<string> {
  const stdin = opts?.stdin ?? process.stdin;
  const stdout = opts?.stdout ?? process.stdout;
  const rlFactory = opts?.rlFactory ?? defaultRlFactory;
  const scopes = opts?.scopes ?? defaultTtyScopes;

  const label = formatPromptLabel({ username: opts?.username });

  return defaultTtyScopes.withCookedTTY(async () => {
    const rl = rlFactory({ input: stdin, output: stdout, terminal: true });
    try {
      // readline prints the label once; no extra banners here
      const answer = await rl.question(label);
      return answer;
    } finally {
      rl.close();
    }
  });
}

/** For places that only need the label (e.g., logging or UI) */
;;
