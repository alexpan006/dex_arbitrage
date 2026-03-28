/**
 * Pluggable optimizer interface for trade-size search strategies.
 *
 * Any optimizer that satisfies IOptimizer can be swapped into
 * OpportunityDetector via OptimizerFactory without touching other code.
 */

/* ------------------------------------------------------------------ */
/*  Shared value types                                                 */
/* ------------------------------------------------------------------ */

export interface ProfitPoint {
  amountInToken0: bigint;
  profitToken0: bigint;
}

/* ------------------------------------------------------------------ */
/*  Metrics reported by every optimizer                                */
/* ------------------------------------------------------------------ */

export interface OptimizerMetrics {
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  /** Total evaluateProfit / batchEvaluateProfit calls (excluding cache hits) */
  evaluationCount: number;
  /** Number of evaluations served from the internal dedup cache */
  cacheHits: number;
  /** Number of grid/sample points evaluated (first pass) */
  gridPointCount: number;
  /** True when the evaluation budget was hit before search completed */
  budgetExhausted: boolean;
  bestAmountToken0: bigint | null;
  bestProfitToken0: bigint | null;
}

/* ------------------------------------------------------------------ */
/*  Result envelope                                                    */
/* ------------------------------------------------------------------ */

export interface OptimizerResult {
  bestPoint: ProfitPoint | null;
  metrics: OptimizerMetrics;
}

/* ------------------------------------------------------------------ */
/*  Core interface                                                     */
/* ------------------------------------------------------------------ */

export interface IOptimizer {
  /**
   * Search for the trade amount that maximises profit.
   *
   * @param evaluateProfit  Single-amount evaluator.  Returns profit (may be
   *                        negative) or null on quote failure.
   * @param batchEvaluateProfit  Optional batch evaluator for the grid phase.
   */
  optimize(
    evaluateProfit: (amountInToken0: bigint) => Promise<bigint | null>,
    batchEvaluateProfit?: (amounts: bigint[]) => Promise<(bigint | null)[]>,
  ): Promise<OptimizerResult>;
}

/* ------------------------------------------------------------------ */
/*  Factory type used by OpportunityDetector                           */
/* ------------------------------------------------------------------ */

/**
 * Called once per pair per detection cycle.  The detector passes the
 * pair-specific borrow bounds and receives a fresh optimizer instance.
 */
export type OptimizerFactory = (options: {
  minAmountToken0: bigint;
  maxAmountToken0: bigint;
}) => IOptimizer;
