import { STRATEGY } from "../config/constants";
import { Dex } from "../config/pools";
import { PoolState } from "../feeds/PoolStateCache";
import { createLogger } from "../utils/logger";
import { relativeDiffBps, sqrtPriceX96ToPriceFloat } from "../utils/math";
import { HybridAmountOptimizer, HybridOptimizerMetrics } from "./HybridAmountOptimizer";
import { QuoterService } from "./QuoterService";

const logger = createLogger("OpportunityDetector");

export interface Opportunity {
  token0: string;
  token1: string;
  fee: number;
  borrowDex: Dex;
  buyPool: PoolState;
  sellPool: PoolState;
  grossSpreadBps: number;
  estimatedBorrowAmountToken0: bigint;
  amountOutMinToken0: bigint;
}

export interface OpportunityDetectorOptions {
  minSpreadBps: number;
  maxBorrowToken0: bigint;
  minExpectedProfitToken0: bigint;
  minBorrowToken0: bigint;
  coarseRatiosBps: number[];
  refineIterations: number;
  maxQuoteEvaluations: number;
}

const DEFAULT_OPTIONS: OpportunityDetectorOptions = {
  minSpreadBps: 10,
  maxBorrowToken0: 10n * 10n ** 18n,
  minExpectedProfitToken0: 10n ** 15n,
  minBorrowToken0: 10n ** 15n,
  coarseRatiosBps: [1000, 2000, 3500, 5000, 6500, 8000, 9000],
  refineIterations: 4,
  maxQuoteEvaluations: 16,
};

function pairKey(token0: string, token1: string, fee: number): string {
  const a = token0.toLowerCase();
  const b = token1.toLowerCase();
  const left = a < b ? a : b;
  const right = a < b ? b : a;
  return `${left}:${right}:${fee}`;
}

function estimateMinOutToken0(expectedAmountOutToken0: bigint, expectedProfitToken0: bigint): bigint {
  const slippageBufferBps = 25n;
  const bufferedOut = (expectedAmountOutToken0 * (10_000n - slippageBufferBps)) / 10_000n;

  if (expectedProfitToken0 <= 0n) {
    return bufferedOut;
  }

  const minProfitFloor = BigInt(Math.floor(STRATEGY.minProfitThresholdUsd * 1e15));
  const requiredProfit = expectedProfitToken0 > minProfitFloor ? minProfitFloor : expectedProfitToken0;
  return bufferedOut > requiredProfit ? bufferedOut - requiredProfit : bufferedOut;
}

interface CandidateQuote {
  amountInToken0: bigint;
  amountOutToken1: bigint;
  amountBackToken0: bigint;
  profitToken0: bigint;
}

export interface DetectorRunMetrics {
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  pairsScanned: number;
  pairsWithSpread: number;
  opportunitiesFound: number;
  quoteRoundTripAttempts: number;
  quoteRoundTripFailures: number;
  optimizerRuns: number;
  optimizerEvalCount: number;
  optimizerCacheHits: number;
  optimizerBudgetExhaustedCount: number;
  optimizerParabolicAcceptedCount: number;
}

export class OpportunityDetector {
  private readonly options: OpportunityDetectorOptions;
  private readonly quoter: QuoterService;
  private metrics: DetectorRunMetrics = {
    startedAtMs: 0,
    finishedAtMs: 0,
    durationMs: 0,
    pairsScanned: 0,
    pairsWithSpread: 0,
    opportunitiesFound: 0,
    quoteRoundTripAttempts: 0,
    quoteRoundTripFailures: 0,
    optimizerRuns: 0,
    optimizerEvalCount: 0,
    optimizerCacheHits: 0,
    optimizerBudgetExhaustedCount: 0,
    optimizerParabolicAcceptedCount: 0,
  };

  constructor(quoter: QuoterService, options: Partial<OpportunityDetectorOptions> = {}) {
    this.quoter = quoter;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getLastMetrics(): DetectorRunMetrics {
    return this.metrics;
  }

  async detect(states: PoolState[]): Promise<Opportunity[]> {
    const runStartedAt = Date.now();
    let pairsScanned = 0;
    let pairsWithSpread = 0;
    let opportunitiesFound = 0;
    let quoteRoundTripAttempts = 0;
    let quoteRoundTripFailures = 0;
    let optimizerRuns = 0;
    let optimizerEvalCount = 0;
    let optimizerCacheHits = 0;
    let optimizerBudgetExhaustedCount = 0;
    let optimizerParabolicAcceptedCount = 0;

    const byPair = new Map<string, PoolState[]>();

    for (const state of states) {
      const key = pairKey(state.token0, state.token1, state.fee);
      const items = byPair.get(key);
      if (!items) {
        byPair.set(key, [state]);
      } else {
        items.push(state);
      }
    }

    const opportunities: Opportunity[] = [];

    for (const pairStates of byPair.values()) {
      pairsScanned += 1;
      const uni = pairStates.find((s) => s.dex === Dex.UniswapV3);
      const pcs = pairStates.find((s) => s.dex === Dex.PancakeSwapV3);

      if (!uni || !pcs) {
        continue;
      }

      const uniPrice = sqrtPriceX96ToPriceFloat(uni.sqrtPriceX96);
      const pcsPrice = sqrtPriceX96ToPriceFloat(pcs.sqrtPriceX96);
      const spreadBps = relativeDiffBps(uniPrice, pcsPrice);

      if (spreadBps < this.options.minSpreadBps) {
        continue;
      }
      pairsWithSpread += 1;

      const buyPool = uniPrice < pcsPrice ? pcs : uni;
      const sellPool = uniPrice < pcsPrice ? uni : pcs;

      const bestResult = await this.findBestCandidate(buyPool, sellPool);
      optimizerRuns += 1;
      optimizerEvalCount += bestResult.optimizerMetrics.evaluationCount;
      optimizerCacheHits += bestResult.optimizerMetrics.cacheHits;
      if (bestResult.optimizerMetrics.budgetExhausted) {
        optimizerBudgetExhaustedCount += 1;
      }
      if (bestResult.optimizerMetrics.parabolicAccepted) {
        optimizerParabolicAcceptedCount += 1;
      }
      quoteRoundTripAttempts += bestResult.roundTripAttempts;
      quoteRoundTripFailures += bestResult.roundTripFailures;

      const best = bestResult.bestCandidate;
      if (!best) {
        continue;
      }

      if (best.profitToken0 < this.options.minExpectedProfitToken0) {
        continue;
      }

      const amountOutMinToken0 = estimateMinOutToken0(best.amountBackToken0, best.profitToken0);

      const opportunity: Opportunity = {
        token0: buyPool.token0,
        token1: buyPool.token1,
        fee: buyPool.fee,
        borrowDex: buyPool.dex,
        buyPool,
        sellPool,
        grossSpreadBps: spreadBps,
        estimatedBorrowAmountToken0: best.amountInToken0,
        amountOutMinToken0,
      };

      opportunities.push(opportunity);
      opportunitiesFound += 1;
    }

    opportunities.sort((a, b) => b.grossSpreadBps - a.grossSpreadBps);

    if (opportunities.length > 0) {
      logger.info("opportunities detected", {
        count: opportunities.length,
        topSpreadBps: opportunities[0].grossSpreadBps,
      });
    }

    const finishedAt = Date.now();
    this.metrics = {
      startedAtMs: runStartedAt,
      finishedAtMs: finishedAt,
      durationMs: finishedAt - runStartedAt,
      pairsScanned,
      pairsWithSpread,
      opportunitiesFound,
      quoteRoundTripAttempts,
      quoteRoundTripFailures,
      optimizerRuns,
      optimizerEvalCount,
      optimizerCacheHits,
      optimizerBudgetExhaustedCount,
      optimizerParabolicAcceptedCount,
    };

    return opportunities;
  }

  private async findBestCandidate(
    buyPool: PoolState,
    sellPool: PoolState
  ): Promise<{
    bestCandidate: CandidateQuote | null;
    optimizerMetrics: HybridOptimizerMetrics;
    roundTripAttempts: number;
    roundTripFailures: number;
  }> {
    const optimizer = new HybridAmountOptimizer({
      minAmountToken0: this.options.minBorrowToken0,
      maxAmountToken0: this.options.maxBorrowToken0,
      coarseRatiosBps: this.options.coarseRatiosBps,
      refineIterations: this.options.refineIterations,
      maxQuoteEvaluations: this.options.maxQuoteEvaluations,
    });

    let roundTripAttempts = 0;
    let roundTripFailures = 0;

    const { bestPoint, metrics } = await optimizer.optimize(async (amountInToken0) => {
      roundTripAttempts += 1;
      const quote = await this.quoteRoundTrip(buyPool, sellPool, amountInToken0);
      if (!quote) {
        roundTripFailures += 1;
      }
      return quote ? quote.profitToken0 : null;
    });

    if (!bestPoint) {
      return {
        bestCandidate: null,
        optimizerMetrics: metrics,
        roundTripAttempts,
        roundTripFailures,
      };
    }

    roundTripAttempts += 1;
    const confirmed = await this.quoteRoundTrip(buyPool, sellPool, bestPoint.amountInToken0);
    if (!confirmed) {
      roundTripFailures += 1;
    }

    return {
      bestCandidate: confirmed,
      optimizerMetrics: metrics,
      roundTripAttempts,
      roundTripFailures,
    };
  }

  private async quoteRoundTrip(
    buyPool: PoolState,
    sellPool: PoolState,
    amountInToken0: bigint
  ): Promise<CandidateQuote | null> {
    try {
      const firstLeg = await this.quoter.quoteExactInputSingle({
        dex: buyPool.dex,
        tokenIn: buyPool.token0,
        tokenOut: buyPool.token1,
        fee: buyPool.fee,
        amountIn: amountInToken0,
      });

      if (firstLeg.amountOut <= 0n) {
        return null;
      }

      const secondLeg = await this.quoter.quoteExactInputSingle({
        dex: sellPool.dex,
        tokenIn: sellPool.token1,
        tokenOut: sellPool.token0,
        fee: sellPool.fee,
        amountIn: firstLeg.amountOut,
      });

      const profitToken0 = secondLeg.amountOut - amountInToken0;

      return {
        amountInToken0,
        amountOutToken1: firstLeg.amountOut,
        amountBackToken0: secondLeg.amountOut,
        profitToken0,
      };
    } catch (error) {
      logger.debug("quote round-trip failed", {
        token0: buyPool.token0,
        token1: buyPool.token1,
        fee: buyPool.fee,
        error: String(error),
      });
      return null;
    }
  }
}
