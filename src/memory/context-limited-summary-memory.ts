import type { ChatDriver } from "../drivers/types";
import { SummaryMemory } from "./summary-memory";

/** Picks hysteresis watermarks from a context-size budget. */
export class ContextLimitedSummaryMemory extends SummaryMemory {
  constructor(args: {
    driver: ChatDriver;
    model: string;
    systemPrompt?: string;
    contextTokens: number;           // e.g., 8192
    reserveHeaderTokens?: number;    // ≈1200
    reserveResponseTokens?: number;  // ≈800
    avgMessageTokens?: number;       // ≈220
    highRatio?: number;              // 0.70
    lowRatio?: number;               // 0.45
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
    const m = Math.max(40, Math.floor(avgMessageTokens));

    let high = Math.floor(highRatio * (budget / m));
    let low  = Math.floor(lowRatio  * (budget / m));

    high = Math.max(8, high);
    low  = Math.max(4, Math.min(low, high - 2));

    super({ driver, model, systemPrompt, highWatermark: high, lowWatermark: low });
  }

  static for8k(args: Omit<ConstructorParameters<typeof ContextLimitedSummaryMemory>[0], "contextTokens">) {
    return new ContextLimitedSummaryMemory({ ...args, contextTokens: 8192 });
  }
}
