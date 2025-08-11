

// policy.ts — shared gates & scoring so BLUE and GREEN are comparable
// Keep this file tiny and dependency-free so both rollout and fitness can import it.

export type Metrics = {
  /** True if any raw tool JSON leaked to visible chat (stdout/stderr/exit_code/ok). */
  jsonLeak: boolean;
  /** True if the project built successfully (e.g., `make -s` exit code == 0). */
  buildOK: boolean;
  /** True if tests passed; null if no tests detected or not runnable. */
  testsOK: boolean | null;
  /** Median benchmark time in milliseconds; null if no benchmark measured. */
  benchMs: number | null;
  /** Optional: informational knobs for future policies */
  toolCalls?: number;   // lower is generally better
  tokensUsed?: number;  // lower is generally better
};

/** Hard gate: must pass to be eligible for promotion. */
export function passed(m: Metrics): boolean {
  if (m.jsonLeak) return false;       // never promote if it leaks raw tool JSON
  if (!m.buildOK) return false;       // must build
  if (m.testsOK === false) return false; // tests present and failing -> reject
  // If tests are null (absent), we allow, but you can tighten later.
  return true;
}

/**
 * Scalar score used for ranking candidates of the same task.
 * Higher is better. Bench is handled separately for strict non-regression.
 */
export function score(m: Metrics): number {
  let s = 0;
  s += m.buildOK ? 50 : 0;
  s += m.testsOK ? 30 : 0;        // null adds 0
  s += m.benchMs !== null ? 10 : 0; // presence bonus; absolute compare is separate
  s += m.jsonLeak ? -100 : 0;     // heavy penalty if leak was observed

  // Soft shaping terms (optional, only if provided)
  if (typeof m.toolCalls === 'number') s -= 0.2 * m.toolCalls;
  if (typeof m.tokensUsed === 'number') s -= 0.001 * m.tokensUsed;
  return s;
}

/** Pretty-print a compact summary for logs. */
export function summarize(m: Metrics): string {
  const parts = [
    `build=${m.buildOK ? 'ok' : 'fail'}`,
    `tests=${m.testsOK === null ? 'na' : (m.testsOK ? 'ok' : 'fail')}`,
    `bench=${m.benchMs === null ? 'na' : m.benchMs.toFixed(1)+'ms'}`,
    `leak=${m.jsonLeak ? 'yes' : 'no'}`,
  ];
  if (typeof m.toolCalls === 'number') parts.push(`tools=${m.toolCalls}`);
  if (typeof m.tokensUsed === 'number') parts.push(`tokens=${m.tokensUsed}`);
  return parts.join(' ');
}

/**
 * Promotion policy between BLUE (baseline) and GREEN (candidate).
 * - GREEN must pass hard gate.
 * - GREEN score must be >= BLUE score.
 * - If both have bench numbers, GREEN must be no slower (<=) than BLUE.
 */
export function allowPromotion(green: Metrics, blue: Metrics): boolean {
  if (!passed(green)) return false;
  const sG = score(green);
  const sB = score(blue);
  if (sG < sB) return false;

  // Strict non-regression on benchmark if both present
  if (green.benchMs !== null && blue.benchMs !== null) {
    if (green.benchMs > blue.benchMs) return false;
  }
  return true;
}