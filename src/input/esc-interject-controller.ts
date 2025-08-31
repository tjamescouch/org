// src/input/esc-interject-controller.ts
// Centralizes ESC and 'i' behavior with explicit state + idempotency.
// Additive and safe: does nothing until imported/wired.

export enum RunPhase {
  Idle = "Idle",
  Streaming = "Streaming",
  InterjectPrompt = "InterjectPrompt",
  AskUserPrompt = "AskUserPrompt",
  Review = "Review",
  ShuttingDown = "ShuttingDown",
}

export interface LoggerLike {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface ReviewResult {
  patchProduced: boolean;
  applied?: boolean;
}

export interface ReviewOpener {
  // Should perform: finalize sandbox → emit session.patch → open pager/confirm.
  // If no patch is produced, it should return { patchProduced:false }.
  finalizeAndReview(): Promise<ReviewResult>;
}

export interface InterjectionOpener {
  // Opens a single-line interjection prompt ("You: ...") in cooked mode.
  openInterjectionPrompt(): Promise<void>;
}

export interface EscInterjectOptions {
  // Query whether the current UI is interactive (console/tmux). If false, 'i' is ignored.
  isInteractive(): boolean;

  logger: LoggerLike;
  review: ReviewOpener;
  interject: InterjectionOpener;

  // Optional status sink for single-line notices ("waiting...", etc.).
  onStatusLine?(msg: string): void;
}

export class EscInterjectController {
  private phase: RunPhase = RunPhase.Idle;

  private shutdownRequested = false;
  private interjectPending = false;

  private reviewOpenInFlight: Promise<void> | null = null;
  private interjectOpenInFlight: Promise<void> | null = null;

  constructor(private readonly opts: EscInterjectOptions) {}

  /** Model stream lifecycle hooks (call from scheduler/runner) */
  onStreamStart(): void {
    // If a review/interject prompt isn't already active, mark Streaming.
    if (this.phase === RunPhase.Idle) this.phase = RunPhase.Streaming;
  }

  onStreamEnd(): void {
    // Resolve queued intents in priority order: ESC > interject.
    if (this.shutdownRequested) {
      void this.openReviewOnce();
      return;
    }
    if (this.interjectPending && this.opts.isInteractive()) {
      this.interjectPending = false;
      void this.openInterjectOnce();
      return;
    }
    // Otherwise return to Idle.
    this.phase = RunPhase.Idle;
  }

  /** Key handlers */
  handleEscKey(): void {
    // ESC is always honored (interactive or not).
    this.shutdownRequested = true;

    if (this.isStreamingLike()) {
      this.status(
        "⏳ ESC pressed — finishing current step, then patch review… (Ctrl+C to abort immediately)"
      );
      this.phase = RunPhase.ShuttingDown; // latch
      return; // defer to onStreamEnd()
    }
    void this.openReviewOnce();
  }

  handleInterjectKey(): void {
    // 'i' only in interactive mode; ESC always preempts.
    if (!this.opts.isInteractive()) return;
    if (this.shutdownRequested) return; // ESC wins

    if (this.isStreamingLike()) {
      if (!this.interjectPending) {
        this.interjectPending = true;
        this.status("…waiting for model to finish before interjection");
      }
      return; // defer
    }
    void this.openInterjectOnce();
  }

  /** Helpers */

  private isStreamingLike(): boolean {
    return (
      this.phase === RunPhase.Streaming ||
      this.phase === RunPhase.ShuttingDown
    );
  }

  private async openReviewOnce(): Promise<void> {
    if (this.reviewOpenInFlight) return this.reviewOpenInFlight;

    this.phase = RunPhase.Review;
    this.reviewOpenInFlight = (async () => {
      try {
        const res = await this.opts.review.finalizeAndReview();
        if (!res.patchProduced) {
          // No patch → clean exit is the upstream responsibility.
          this.opts.logger.info("No patch produced; exiting cleanly.");
        }
      } catch (err) {
        this.opts.logger.warn(`Review failed: ${String(err)}`);
      } finally {
        // After review completes, upstream should exit; but if not:
        this.reviewOpenInFlight = null;
        // Fall back to Idle so repeated ESC won't re-open indefinitely.
        this.phase = RunPhase.Idle;
      }
    })();

    return this.reviewOpenInFlight;
  }

  private async openInterjectOnce(): Promise<void> {
    if (this.interjectOpenInFlight) return this.interjectOpenInFlight;
    if (!this.opts.isInteractive()) return;

    this.phase = RunPhase.InterjectPrompt;
    this.interjectOpenInFlight = (async () => {
      try {
        await this.opts.interject.openInterjectionPrompt();
      } catch (err) {
        this.opts.logger.warn(`Interjection prompt failed: ${String(err)}`);
      } finally {
        this.interjectOpenInFlight = null;
        // Return to Idle only if no stream resumed meanwhile.
        if (!this.shutdownRequested) this.phase = RunPhase.Idle;
      }
    })();

    return this.interjectOpenInFlight;
  }

  private status(msg: string): void {
    if (this.opts.onStatusLine) this.opts.onStatusLine(msg);
    else this.opts.logger.info(msg);
  }
}
