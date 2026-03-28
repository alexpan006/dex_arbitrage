import { IOptimizer, OptimizerMetrics, OptimizerResult, ProfitPoint } from "./IOptimizer";

/**
 * Log-scale grid optimizer.
 *
 * Instead of the old linear grid (15 %, 35 %, 55 %, 75 %, 90 %) that missed
 * small trade sizes, this uses an adaptive grid with heavier sampling at the
 * low end where thin-liquidity pools actually have profitable amounts.
 *
 * Default grid (bps of maxAmountToken0):
 *   10, 50, 100, 300, 700, 1500, 3500, 6500, 9000
 *
 * For $100 K maxBorrow → $100, $500, $1 K, $3 K, $7 K, $15 K, $35 K, $65 K, $90 K
 */

export interface AdaptiveGridOptimizerOptions {
  minAmountToken0: bigint;
  maxAmountToken0: bigint;
  /** Grid ratios in bps of maxAmountToken0.  Defaults to log-scale coverage. */
  gridRatiosBps?: number[];
  /** Hard cap on evaluateProfit calls (including batch). */
  maxQuoteEvaluations?: number;
}

const BPS_DENOMINATOR = 10_000n;

const DEFAULT_GRID_RATIOS_BPS: number[] = [
  10,    // 0.1 %
  50,    // 0.5 %
  100,   // 1 %
  300,   // 3 %
  700,   // 7 %
  1500,  // 15 %
  3500,  // 35 %
  6500,  // 65 %
  9000,  // 90 %
];

function clampBigInt(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export class AdaptiveGridOptimizer implements IOptimizer {
  private readonly options: Required<AdaptiveGridOptimizerOptions>;

  constructor(options: AdaptiveGridOptimizerOptions) {
    this.options = {
      minAmountToken0: options.minAmountToken0,
      maxAmountToken0: options.maxAmountToken0,
      gridRatiosBps: options.gridRatiosBps ?? DEFAULT_GRID_RATIOS_BPS,
      maxQuoteEvaluations: options.maxQuoteEvaluations ?? 12,
    };
  }

  async optimize(
    evaluateProfit: (amountInToken0: bigint) => Promise<bigint | null>,
    batchEvaluateProfit?: (amounts: bigint[]) => Promise<(bigint | null)[]>,
  ): Promise<OptimizerResult> {
    const startedAtMs = Date.now();
    const evaluated = new Map<string, ProfitPoint>();
    let evalCount = 0;
    let cacheHits = 0;
    let budgetExhausted = false;

    const rawAmounts = this.options.gridRatiosBps.map((ratioBps) =>
      clampBigInt(
        (this.options.maxAmountToken0 * BigInt(ratioBps)) / BPS_DENOMINATOR,
        this.options.minAmountToken0,
        this.options.maxAmountToken0,
      ),
    );

    const uniqueAmounts: bigint[] = [];
    const uniqueKeys = new Set<string>();
    for (const amount of rawAmounts) {
      const key = amount.toString();
      if (!uniqueKeys.has(key)) {
        uniqueKeys.add(key);
        uniqueAmounts.push(amount);
      }
    }

    const deduped = rawAmounts.length - uniqueAmounts.length;
    cacheHits += deduped;

    const gridPoints: ProfitPoint[] = [];

    if (batchEvaluateProfit) {
      const toEval = uniqueAmounts.slice(0, this.options.maxQuoteEvaluations);
      if (toEval.length < uniqueAmounts.length) {
        budgetExhausted = true;
      }
      evalCount += toEval.length;

      const batchResults = await batchEvaluateProfit(toEval);
      for (let i = 0; i < toEval.length; i++) {
        const profit = batchResults[i];
        if (profit !== null) {
          const point: ProfitPoint = { amountInToken0: toEval[i], profitToken0: profit };
          evaluated.set(toEval[i].toString(), point);
          gridPoints.push(point);
        }
      }
    } else {
      for (const amount of uniqueAmounts) {
        if (evalCount >= this.options.maxQuoteEvaluations) {
          budgetExhausted = true;
          break;
        }
        evalCount += 1;

        const key = amount.toString();
        const cached = evaluated.get(key);
        if (cached) {
          cacheHits += 1;
          gridPoints.push(cached);
          continue;
        }

        const profit = await evaluateProfit(amount);
        if (profit !== null) {
          const point: ProfitPoint = { amountInToken0: amount, profitToken0: profit };
          evaluated.set(key, point);
          gridPoints.push(point);
        }
      }
    }

    if (gridPoints.length === 0) {
      return this.buildResult(startedAtMs, evalCount, cacheHits, 0, budgetExhausted, null);
    }

    const best = gridPoints.reduce((acc, cur) =>
      cur.profitToken0 > acc.profitToken0 ? cur : acc,
    );

    return this.buildResult(
      startedAtMs,
      evalCount,
      cacheHits,
      gridPoints.length,
      budgetExhausted,
      best,
    );
  }

  private buildResult(
    startedAtMs: number,
    evaluationCount: number,
    cacheHits: number,
    gridPointCount: number,
    budgetExhausted: boolean,
    best: ProfitPoint | null,
  ): OptimizerResult {
    const finishedAtMs = Date.now();
    const metrics: OptimizerMetrics = {
      startedAtMs,
      finishedAtMs,
      durationMs: finishedAtMs - startedAtMs,
      evaluationCount,
      cacheHits,
      gridPointCount,
      budgetExhausted,
      bestAmountToken0: best?.amountInToken0 ?? null,
      bestProfitToken0: best?.profitToken0 ?? null,
    };
    return { bestPoint: best, metrics };
  }
}
