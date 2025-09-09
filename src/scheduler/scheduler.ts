/**
 * Public scheduler API (type-safe).
 */

import { ChatMessage } from "../drivers/types";

type ReviewMode = "ask" | "auto" | "never";
type OnAskUser = (fromAgent: string, content: string) => Promise<void>;

type ChatRole = "system" | "user" | "assistant" | "tool";

/** The app and input layer talk to a scheduler via this interface only. */
export interface IScheduler {
  /** Start the run loop. Returns once stopped/drained. */
  start(): Promise<void>;

  /** Request a graceful stop (soon). */
  stop(): void;

  /** Drain outstanding work, then stop. */
  drain(): Promise<boolean>;

  interject(s: string): Promise<void>;
}

/** Agent shape schedulers coordinate. Only what we need. */
interface SchedulerAgent {
  id: string;

  /**
   * Ask the agent to respond to messages.
   * `shouldAbort` allows the loop to stop early.
   */
  respond(
    messages: ChatMessage[],
    maxTools: number,
    peers: string[],
    shouldAbort: () => boolean
  ): Promise<string | void> | string | void;

  guardOnIdle?(state: unknown): unknown | null;
  guardCheck?(route: unknown, content: string, peers: string[]): unknown | null;
}

/** Options used to construct a scheduler. */
interface SchedulerOptions {
  agents: SchedulerAgent[];
  maxTools: number;
  onAskUser: OnAskUser;
  projectDir: string;
  reviewMode: ReviewMode;

  /** If true, scheduler may prompt the user first; app sets false when seeded. */
  promptEnabled: boolean;
}

export type SchedulerLike = IScheduler;
