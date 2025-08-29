export type ReviewMode = "ask" | "auto" | "never";

export type OnAskUser = (fromAgent: string, content: string) => Promise<void>;

/** The app talks to any scheduler through this interface only. */
export interface IScheduler {
  /** Start the run loop. Returns when the loop is stopped or drained. */
  start(): Promise<void>;

  /** Request a graceful stop (stop soon). */
  stop(): Promise<void>;

  /** Drain outstanding work, then stop. */
  drain(): Promise<void>;

  /** Enqueue a user text message for processing. */
  enqueueUserText(text: string): Promise<void>;
}

/** Agent shape schedulers coordinate. Only what we actually use. */
export interface SchedulerAgent {
  id: string;

  /**
   * Ask the agent to respond to `prompt`. Return streamed or full text; both
   * are acceptable. The callback `shouldAbort` allows the loop to stop early.
   */
  respond(
    prompt: string,
    budget: number,
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
   * The app will set this to false when a kickoff seed is provided.
   */
  promptEnabled: boolean;
}

export type SchedulerLike = IScheduler; // for legacy imports