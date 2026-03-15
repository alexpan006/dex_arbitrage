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

function toTokenFloat(amount: bigint): number {
  return Number(amount) / 1e18;
}

function fromTokenFloat(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0n;
  }
  return BigInt(Math.floor(amount * 1e18));
}

function solveParabolicVertex(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): number | null {
  const d12 = (y2 - y1) / (x2 - x1);
  const d23 = (y3 - y2) / (x3 - x2);
  const a = (d23 - d12) / (x3 - x1);
  const b = d12 - a * (x1 + x2);

  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= 0) {
    return null;
  }

  const vertex = -b / (2 * a);
  return Number.isFinite(vertex) ? vertex : null;
}

function pointByAmount(points: ProfitPoint[]): Map<string, ProfitPoint> {
  const map = new Map<string, ProfitPoint>();
  for (const point of points) {
    map.set(point.amountInToken0.toString(), point);
  }
  return map;
}

function sortedByAmount(points: ProfitPoint[]): ProfitPoint[] {
  return [...points].sort((a, b) => (a.amountInToken0 < b.amountInToken0 ? -1 : a.amountInToken0 > b.amountInToken0 ? 1 : 0));
}

export class HybridAmountOptimizer {
  private readonly options: HybridAmountOptimizerOptions;

  constructor(options: HybridAmountOptimizerOptions) {
    this.options = options;
  }

  async optimize(evaluateProfit: (amountInToken0: bigint) => Promise<bigint | null>): Promise<HybridOptimizerResult> {
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
    for (const ratioBps of this.options.coarseRatiosBps) {
      const amount = (this.options.maxAmountToken0 * BigInt(ratioBps)) / BPS_DENOMINATOR;
      const point = await evalAt(amount);
      if (point) {
        coarsePoints.push(point);
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

    const byAmount = pointByAmount(coarsePoints);
    const ordered = sortedByAmount(coarsePoints);
    const bestIndex = ordered.findIndex((p) => p.amountInToken0 === best.amountInToken0);

    if (bestIndex > 0 && bestIndex < ordered.length - 1) {
      const left = ordered[bestIndex - 1];
      const center = ordered[bestIndex];
      const right = ordered[bestIndex + 1];
      parabolicTried = true;

      const vertex = solveParabolicVertex(
        toTokenFloat(left.amountInToken0),
        toTokenFloat(left.profitToken0),
        toTokenFloat(center.amountInToken0),
        toTokenFloat(center.profitToken0),
        toTokenFloat(right.amountInToken0),
        toTokenFloat(right.profitToken0)
      );

      if (vertex !== null) {
        const vertexAmount = clampBigInt(fromTokenFloat(vertex), this.options.minAmountToken0, this.options.maxAmountToken0);
        const vertexPoint = await evalAt(vertexAmount);
        if (vertexPoint && vertexPoint.profitToken0 > best.profitToken0) {
          best = vertexPoint;
          parabolicAccepted = true;
        }
      }
    }

    let left = clampBigInt(best.amountInToken0 / 2n, this.options.minAmountToken0, this.options.maxAmountToken0);
    let right = clampBigInt((best.amountInToken0 * 2n), this.options.minAmountToken0, this.options.maxAmountToken0);
    if (left >= right) {
      left = this.options.minAmountToken0;
      right = this.options.maxAmountToken0;
    }

    const leftKnown = byAmount.get(left.toString()) ?? (await evalAt(left));
    const rightKnown = byAmount.get(right.toString()) ?? (await evalAt(right));
    if (leftKnown && leftKnown.profitToken0 > best.profitToken0) {
      best = leftKnown;
    }
    if (rightKnown && rightKnown.profitToken0 > best.profitToken0) {
      best = rightKnown;
    }

    for (let i = 0; i < this.options.refineIterations; i += 1) {
      refineIterationsExecuted += 1;
      if (right - left <= this.options.minAmountToken0) {
        break;
      }

      const span = right - left;
      const x1 = left + (span * GOLDEN_LOWER_BPS) / BPS_DENOMINATOR;
      const x2 = left + (span * GOLDEN_UPPER_BPS) / BPS_DENOMINATOR;

      const p1 = await evalAt(x1);
      const p2 = await evalAt(x2);
      if (!p1 && !p2) {
        break;
      }

      if (p1 && p1.profitToken0 > best.profitToken0) {
        best = p1;
      }
      if (p2 && p2.profitToken0 > best.profitToken0) {
        best = p2;
      }

      if (!p1) {
        left = x1;
        continue;
      }
      if (!p2) {
        right = x2;
        continue;
      }

      if (p1.profitToken0 < p2.profitToken0) {
        left = x1;
      } else {
        right = x2;
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
