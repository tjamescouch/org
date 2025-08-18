import type { ChatDriver } from "../drivers/types";
import { SummaryMemory } from "./summary-memory";

/**
 * ContextLimitedSummaryMemory
 *
 * A SummaryMemory that chooses HIGH/LOW watermarks automatically
 * from a target model context size (e.g., 8192 for ~8k).
 *
 * Heuristic (token-budget based):
 *   - Reserve ~1200 tokens for system/tool schema and ~800 for the model reply
 *     (total reserve ≈ 2000; configurable).
 *   - Let B = contextTokens - reserveTokens.
 *   - Estimate average tokens per message 'm' (default 220; configurable).
 *   - Set:
 *       high ≈ floor( highRatio * B / m )   // default highRatio = 0.70
 *       low  ≈ floor(  lowRatio * B / m )   // default lowRatio  = 0.45
 *   - Clamp to sane bounds and ensure low < high - 1.
 *
 * This keeps you safely below the model's window even when a few long
 * messages slip in (tool output, patches, etc.).
 */
export class ContextLimitedSummaryMemory extends SummaryMemory {
  /**
   * Construct with an explicit context size and optional tuning knobs.
   *
   * @param args.contextTokens    Total context window (e.g., 8192, 32768)
   * @param args.reserveHeaderTokens Approx tokens reserved for system/tool schema (default 1200)
   * @param args.reserveResponseTokens Approx tokens reserved for the model's reply (default 800)
   * @param args.avgMessageTokens Estimated mean tokens per message (default 220)
   * @param args.highRatio        Fraction of budget used for HIGH watermark (default 0.70)
   * @param args.lowRatio         Fraction of budget used for LOW watermark  (default 0.45)
   */
  constructor(args: {
    driver: ChatDriver;
    model: string;
    systemPrompt?: string;

    // Context and heuristic params
    contextTokens: number;
    reserveHeaderTokens?: number;   // ≈ 1200
    reserveResponseTokens?: number; // ≈ 800
    avgMessageTokens?: number;      // ≈ 220
    highRatio?: number;             // 0.70
    lowRatio?: number;              // 0.45
  }) {
    const {
      driver, model, systemPrompt,
      contextTokens,
      reserveHeaderTokens = 1200,
      reserveResponseTokens = 800,
      avgMessageTokens = 220,
      highRatio = 0.70,
      lowRatio = 0.45,
    } = args;

    const reserve = Math.max(0, Math.floor(reserveHeaderTokens + reserveResponseTokens));
    const budget  = Math.max(256, Math.floor(contextTokens - reserve));

    const m = Math.max(40, Math.floor(avgMessageTokens)); // guard against tiny m
    let high = Math.floor(highRatio * (budget / m));
    let low  = Math.floor(lowRatio  * (budget / m));

    // Sane bounds + spacing
    high = Math.max(8, high);
    low  = Math.max(4, low);

    if (low >= high) {
      // ensure hysteresis gap
      low = Math.max(4, Math.floor(high * 0.65));
    }
    if (high - low < 2) {
      // enforce at least a 2-message gap
      low = Math.max(4, high - 2);
    }

    super({
      driver,
      model,
      systemPrompt,
      highWatermark: high,
      lowWatermark: low,
    });
  }

  /** Convenience constructor for common windows. */
  static for8k(args: Omit<ConstructorParameters<typeof ContextLimitedSummaryMemory>[0], "contextTokens">) {
    return new ContextLimitedSummaryMemory({ ...args, contextTokens: 8192 });
  }
}
