import type { ISandboxSession } from "../sandbox/types";
import { Agent } from "../agents/agent";


export type ChatResponse = { message: string; toolsUsed: number };


export type AskUserFn = (fromAgent: string, content: string) => Promise<void>;


export type SchedulerOptions = {
  agents: Agent[];
  maxTools: number;
  projectDir: string;
  reviewMode?: "ask" | "never" | "auto"
  onAskUser: AskUserFn;
  promptEnabled?: boolean;
  idleSleepMs?: number;
  shuffle?: <T>(arr: T[]) => T[];
  sandbox: ISandboxSession;            // <-- NEW (required)
};
