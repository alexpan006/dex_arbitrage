import { IOptimizer, OptimizerMetrics, OptimizerResult, ProfitPoint } from "./IOptimizer";

export { ProfitPoint };

export type HybridOptimizerMetrics = OptimizerMetrics;
export type HybridOptimizerResult = OptimizerResult;

export interface HybridAmountOptimizerOptions {
  minAmountToken0: bigint;
  maxAmountToken0: bigint;
  coarseRatiosBps: number[];
  maxQuoteEvaluations: number;
}

const BPS_DENOMINATOR = 10_000n;

function clampBigInt(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export class HybridAmountOptimizer implements IOptimizer {
  private readonly options: HybridAmountOptimizerOptions;

  constructor(options: HybridAmountOptimizerOptions) {
    this.options = options;
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

    const evalAt = async (amountInToken0: bigint): Promise<ProfitPoint | null> => {
      const amount = clampBigInt(amountInToken0, this.options.minAmountToken0, this.options.maxAmountToken0);
      const key = amount.toString();
      const cached = evaluated.get(key);
      if (cached) {
        cacheHits += 1;
        return cached;
      }

      if (evalCount >= this.options.maxQuoteEvaluations) {
        budgetExhausted = true;
        return null;
      }

      evalCount += 1;
      const profit = await evaluateProfit(amount);
      if (profit === null) {
        return null;
      }

      const point: ProfitPoint = { amountInToken0: amount, profitToken0: profit };
      evaluated.set(key, point);
      return point;
    };

    const coarsePoints: ProfitPoint[] = [];

    if (batchEvaluateProfit) {
      const coarseAmounts = this.options.coarseRatiosBps.map(
        (ratioBps) => clampBigInt(
          (this.options.maxAmountToken0 * BigInt(ratioBps)) / BPS_DENOMINATOR,
          this.options.minAmountToken0,
          this.options.maxAmountToken0,
        ),
      );

      const uniqueAmounts: bigint[] = [];
      const uniqueKeys = new Set<string>();
      for (const amount of coarseAmounts) {
        const key = amount.toString();
        if (!uniqueKeys.has(key)) {
          uniqueKeys.add(key);
          uniqueAmounts.push(amount);
        }
      }

      evalCount += uniqueAmounts.length;
      if (evalCount > this.options.maxQuoteEvaluations) {
        budgetExhausted = true;
        evalCount = this.options.maxQuoteEvaluations;
      }

      const batchResults = await batchEvaluateProfit(uniqueAmounts);
      for (let i = 0; i < uniqueAmounts.length; i++) {
        const profit = batchResults[i];
        if (profit !== null) {
          const point: ProfitPoint = { amountInToken0: uniqueAmounts[i], profitToken0: profit };
          evaluated.set(uniqueAmounts[i].toString(), point);
          coarsePoints.push(point);
        }
      }

      const deduped = coarseAmounts.length - uniqueAmounts.length;
      cacheHits += deduped;
    } else {
      for (const ratioBps of this.options.coarseRatiosBps) {
        const amount = (this.options.maxAmountToken0 * BigInt(ratioBps)) / BPS_DENOMINATOR;
        const point = await evalAt(amount);
        if (point) {
          coarsePoints.push(point);
        }
      }
    }

    if (coarsePoints.length === 0) {
      const finishedAtMs = Date.now();
      return {
        bestPoint: null,
        metrics: {
          startedAtMs,
          finishedAtMs,
          durationMs: finishedAtMs - startedAtMs,
          evaluationCount: evalCount,
          cacheHits,
          gridPointCount: 0,
          budgetExhausted,
          bestAmountToken0: null,
          bestProfitToken0: null,
        },
      };
    }

    const best = coarsePoints.reduce((acc, cur) => (cur.profitToken0 > acc.profitToken0 ? cur : acc));

    const finishedAtMs = Date.now();
    return {
      bestPoint: best,
      metrics: {
        startedAtMs,
        finishedAtMs,
        durationMs: finishedAtMs - startedAtMs,
        evaluationCount: evalCount,
        cacheHits,
        gridPointCount: coarsePoints.length,
        budgetExhausted,
        bestAmountToken0: best.amountInToken0,
        bestProfitToken0: best.profitToken0,
      },
    };
  }
}
