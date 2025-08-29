/**
 * Public scheduler API (type-safe).
 * Keep this surface conservative but sufficient for the app and input layer.
 */

export type ReviewMode = "ask" | "auto" | "never";

export type OnAskUser = (fromAgent: string, content: string) => Promise<void>;

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** Minimal chat message used by the scheduler and agents. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional origin/destination to support routing */
  from?: string;
  to?: string; // "@group" means broadcast to any agent
}

/** The app talks to any scheduler through this interface only. */
export interface IScheduler {
  /** Start the run loop. Returns when the loop is stopped or drained. */
  start(): Promise<void>;

  /** Request a graceful stop (stop soon). */
  stop(): Promise<void>;

  /** Drain outstanding work, then stop. */
  drain(): Promise<void>;

  /** Enqueue a user text message. Scheduler converts this to a ChatMessage. */
  enqueueUserText(text: string, opts?: { to?: string; from?: string }): Promise<void>;
}

/** Agent shape schedulers coordinate. Only what we need. */
export interface SchedulerAgent {
  id: string;

  /**
   * Ask the agent to respond to `messages`.
   * The callback `shouldAbort` allows the loop to stop early.
   */
  respond(
    messages: ChatMessage[],
    maxTools: number,
    peers: string[],
    shouldAbort: () => boolean
  ): Promise<string | void> | string | void;

  /** Optional guard hooks (not used by the simple scheduler below). */
  guardOnIdle?(state: unknown): unknown | null;
  guardCheck?(route: unknown, content: string, peers: string[]): unknown | null;
}

/** Options used to construct a scheduler. */
export interface SchedulerOptions {
  agents: SchedulerAgent[];
  maxTools: number;
  onAskUser: OnAskUser;
  projectDir: string;
  reviewMode: ReviewMode;

  /**
   * If true, the scheduler is allowed to prompt the user first (askUser).
   * The app sets this to false when a kickoff seed is provided.
   */
  promptEnabled: boolean;
}
