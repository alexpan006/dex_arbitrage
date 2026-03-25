export interface ProfitPoint {
  amountInToken0: bigint;
  profitToken0: bigint;
}

export interface HybridOptimizerMetrics {
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  evaluationCount: number;
  cacheHits: number;
  coarsePointCount: number;
  parabolicTried: boolean;
  parabolicAccepted: boolean;
  refineIterationsExecuted: number;
  budgetExhausted: boolean;
  bestAmountToken0: bigint | null;
  bestProfitToken0: bigint | null;
}

export interface HybridOptimizerResult {
  bestPoint: ProfitPoint | null;
  metrics: HybridOptimizerMetrics;
}

export interface HybridAmountOptimizerOptions {
  minAmountToken0: bigint;
  maxAmountToken0: bigint;
  coarseRatiosBps: number[];
  refineIterations: number;
  maxQuoteEvaluations: number;
}

const GOLDEN_LOWER_BPS = 3819n;
const GOLDEN_UPPER_BPS = 6181n;
const BPS_DENOMINATOR = 10_000n;

function clampBigInt(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function solveParabolicVertexNormalized(
  x1: bigint, y1: bigint,
  x2: bigint, y2: bigint,
  x3: bigint, y3: bigint,
): bigint | null {
  const span = Number(x3 - x1);
  if (span <= 0) return null;

  const t1 = 0;
  const t2 = Number(x2 - x1) / span;
  const t3 = 1;

  const fy1 = Number(y1);
  const fy2 = Number(y2);
  const fy3 = Number(y3);

  const d12 = (fy2 - fy1) / (t2 - t1);
  const d23 = (fy3 - fy2) / (t3 - t2);
  const a = (d23 - d12) / (t3 - t1);
  const b = d12 - a * (t1 + t2);

  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= 0) return null;

  const tVertex = -b / (2 * a);
  if (!Number.isFinite(tVertex) || tVertex <= 0 || tVertex >= 1) return null;

  const vertexRaw = Number(x1) + tVertex * span;
  if (!Number.isFinite(vertexRaw) || vertexRaw <= 0) return null;

  return BigInt(Math.floor(vertexRaw));
}

function sortedByAmount(points: ProfitPoint[]): ProfitPoint[] {
  return [...points].sort((a, b) => (a.amountInToken0 < b.amountInToken0 ? -1 : a.amountInToken0 > b.amountInToken0 ? 1 : 0));
}

export class HybridAmountOptimizer {
  private readonly options: HybridAmountOptimizerOptions;

  constructor(options: HybridAmountOptimizerOptions) {
    this.options = options;
  }

  async optimize(
    evaluateProfit: (amountInToken0: bigint) => Promise<bigint | null>,
    batchEvaluateProfit?: (amounts: bigint[]) => Promise<(bigint | null)[]>
  ): Promise<HybridOptimizerResult> {
    const startedAtMs = Date.now();
    const evaluated = new Map<string, ProfitPoint>();
    let evalCount = 0;
    let cacheHits = 0;
    let budgetExhausted = false;
    let parabolicTried = false;
    let parabolicAccepted = false;
    let refineIterationsExecuted = 0;

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
          this.options.maxAmountToken0
        )
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
          coarsePointCount: 0,
          parabolicTried,
          parabolicAccepted,
          refineIterationsExecuted,
          budgetExhausted,
          bestAmountToken0: null,
          bestProfitToken0: null,
        },
      };
    }

    let best = coarsePoints.reduce((acc, cur) => (cur.profitToken0 > acc.profitToken0 ? cur : acc));

    const ordered = sortedByAmount(coarsePoints);
    const bestIndex = ordered.findIndex((p) => p.amountInToken0 === best.amountInToken0);

    if (best.profitToken0 <= 0n) {
      const finishedAtMs = Date.now();
      return {
        bestPoint: best,
        metrics: {
          startedAtMs,
          finishedAtMs,
          durationMs: finishedAtMs - startedAtMs,
          evaluationCount: evalCount,
          cacheHits,
          coarsePointCount: coarsePoints.length,
          parabolicTried,
          parabolicAccepted,
          refineIterationsExecuted,
          budgetExhausted,
          bestAmountToken0: best.amountInToken0,
          bestProfitToken0: best.profitToken0,
        },
      };
    }

    if (bestIndex > 0 && bestIndex < ordered.length - 1) {
      const leftNeighbor = ordered[bestIndex - 1];
      const center = ordered[bestIndex];
      const rightNeighbor = ordered[bestIndex + 1];
      parabolicTried = true;

      const vertexAmount = solveParabolicVertexNormalized(
        leftNeighbor.amountInToken0, leftNeighbor.profitToken0,
        center.amountInToken0, center.profitToken0,
        rightNeighbor.amountInToken0, rightNeighbor.profitToken0,
      );

      if (vertexAmount !== null) {
        const clamped = clampBigInt(vertexAmount, this.options.minAmountToken0, this.options.maxAmountToken0);
        const vertexPoint = await evalAt(clamped);
        if (vertexPoint && vertexPoint.profitToken0 > best.profitToken0) {
          best = vertexPoint;
          parabolicAccepted = true;
        }
      }
    }

    let left = bestIndex > 0
      ? ordered[bestIndex - 1].amountInToken0
      : this.options.minAmountToken0;
    let right = bestIndex < ordered.length - 1
      ? ordered[bestIndex + 1].amountInToken0
      : this.options.maxAmountToken0;
    if (left >= right) {
      left = this.options.minAmountToken0;
      right = this.options.maxAmountToken0;
    }

    let gssC: ProfitPoint | null = null;
    let gssD: ProfitPoint | null = null;

    for (let i = 0; i < this.options.refineIterations; i += 1) {
      refineIterationsExecuted += 1;
      if (right - left <= this.options.minAmountToken0) {
        break;
      }

      const span = right - left;
      const cAmount = left + (span * GOLDEN_LOWER_BPS) / BPS_DENOMINATOR;
      const dAmount = left + (span * GOLDEN_UPPER_BPS) / BPS_DENOMINATOR;

      if (i === 0) {
        gssC = await evalAt(cAmount);
        gssD = await evalAt(dAmount);
      } else if (gssC && !gssD) {
        gssD = await evalAt(dAmount);
      } else if (gssD && !gssC) {
        gssC = await evalAt(cAmount);
      }

      if (!gssC && !gssD) {
        break;
      }

      if (gssC && gssC.profitToken0 > best.profitToken0) {
        best = gssC;
      }
      if (gssD && gssD.profitToken0 > best.profitToken0) {
        best = gssD;
      }

      const cProfit = gssC?.profitToken0 ?? -(1n << 128n);
      const dProfit = gssD?.profitToken0 ?? -(1n << 128n);

      if (cProfit < dProfit) {
        left = gssC?.amountInToken0 ?? cAmount;
        gssC = gssD;
        gssD = null;
      } else {
        right = gssD?.amountInToken0 ?? dAmount;
        gssD = gssC;
        gssC = null;
      }
    }

    const finishedAtMs = Date.now();
    return {
      bestPoint: best,
      metrics: {
        startedAtMs,
        finishedAtMs,
        durationMs: finishedAtMs - startedAtMs,
        evaluationCount: evalCount,
        cacheHits,
        coarsePointCount: coarsePoints.length,
        parabolicTried,
        parabolicAccepted,
        refineIterationsExecuted,
        budgetExhausted,
        bestAmountToken0: best.amountInToken0,
        bestProfitToken0: best.profitToken0,
      },
    };
  }
}
