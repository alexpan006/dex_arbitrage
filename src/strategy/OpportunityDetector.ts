import { STRATEGY } from "../config/constants";
import { Dex, isV4StyleDex } from "../config/pools";
import { getTokenDecimals, isStablecoin } from "../config/tokens";
import { PoolState } from "../feeds/PoolStateCache";
import { TelemetryRecord, TelemetryWriter } from "../monitoring/TelemetryWriter";
import { createLogger } from "../utils/logger";
import { estimateToken0Available, relativeDiffBps, sqrtPriceX96ToPriceFloat } from "../utils/math";
import { IOptimizer, OptimizerFactory, OptimizerMetrics } from "./IOptimizer";
import { AdaptiveGridOptimizer } from "./AdaptiveGridOptimizer";
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
  spreadDiffBps: number;
  maxBorrowAmountUsd: number;
  minProfitThresholdUsd: number;
  maxBorrowToken0?: bigint;
  minExpectedProfitToken0?: bigint;
  minBorrowToken0?: bigint;
  optimizerFactory?: OptimizerFactory;
}

interface PairBorrowBounds {
  maxBorrowToken0: bigint;
  minBorrowToken0: bigint;
  minExpectedProfitToken0: bigint;
  liquidityCap?: bigint;
}

const defaultOptimizerFactory: OptimizerFactory = ({ minAmountToken0, maxAmountToken0 }) =>
  new AdaptiveGridOptimizer({ minAmountToken0, maxAmountToken0 });

const DEFAULT_OPTIONS: OpportunityDetectorOptions = {
  spreadDiffBps: STRATEGY.spreadDiffBps,
  maxBorrowAmountUsd: STRATEGY.maxBorrowAmountUsd,
  minProfitThresholdUsd: STRATEGY.minProfitThresholdUsd,
  optimizerFactory: defaultOptimizerFactory,
};

function pairKey(token0: string, token1: string): string {
  const a = token0.toLowerCase();
  const b = token1.toLowerCase();
  const left = a < b ? a : b;
  const right = a < b ? b : a;
  return `${left}:${right}`;
}

function estimateMinOutToken0(expectedAmountOutToken0: bigint, expectedProfitToken0: bigint, minProfitToken0: bigint): bigint {
  const slippageBufferBps = 25n;
  const bufferedOut = (expectedAmountOutToken0 * (10_000n - slippageBufferBps)) / 10_000n;

  if (expectedProfitToken0 <= 0n) {
    return bufferedOut;
  }

  const requiredProfit = expectedProfitToken0 > minProfitToken0 ? minProfitToken0 : expectedProfitToken0;
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
}

export class OpportunityDetector {
  private readonly options: OpportunityDetectorOptions;
  private readonly quoter: QuoterService;
  private readonly telemetry: TelemetryWriter | null;
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
  };

  constructor(quoter: QuoterService, options: Partial<OpportunityDetectorOptions> = {}, telemetry?: TelemetryWriter) {
    this.quoter = quoter;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.telemetry = telemetry ?? null;
  }

  getLastMetrics(): DetectorRunMetrics {
    return this.metrics;
  }

  async detect(states: PoolState[], blockNumber?: number): Promise<Opportunity[]> {
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

    const byPair = new Map<string, PoolState[]>();

    for (const state of states) {
      const key = pairKey(state.token0, state.token1);
      const items = byPair.get(key);
      if (!items) {
        byPair.set(key, [state]);
      } else {
        items.push(state);
      }
    }

    const opportunities: Opportunity[] = [];

    // Phase A: Spread check — pure math, collect qualified pairs (OPT-2)
    interface QualifiedPair {
      key: string;
      buyPool: PoolState;
      sellPool: PoolState;
      priceA: number;
      priceB: number;
      spreadBps: number;
      bounds: PairBorrowBounds;
    }
    const qualifiedPairs: QualifiedPair[] = [];
    const blk = blockNumber ?? 0;
    const spreadCheckTimestamp = new Date().toISOString();

    for (const [key, pairStates] of byPair) {
      for (let a = 0; a < pairStates.length; a++) {
        for (let b = a + 1; b < pairStates.length; b++) {
          const poolA = pairStates[a];
          const poolB = pairStates[b];

          if (poolA.dex === poolB.dex) {
            continue;
          }

          pairsScanned += 1;

          const priceA = sqrtPriceX96ToPriceFloat(poolA.sqrtPriceX96);
          const priceB = sqrtPriceX96ToPriceFloat(poolB.sqrtPriceX96);
          const spreadBps = relativeDiffBps(priceA, priceB);

          const feeFloorBps = (poolA.fee + poolB.fee) / 100;
          const minSpreadBps = feeFloorBps + this.options.spreadDiffBps;

          const pairLabel = `${key}|${poolA.dex}:${poolA.fee}-${poolB.dex}:${poolB.fee}`;

          if (spreadBps < minSpreadBps) {
            this.emitPairTelemetry(spreadCheckTimestamp, blk, pairLabel, poolA.dex, poolB.dex, priceA, priceB, spreadBps, false, false, "spread_below_min");
            continue;
          }
          pairsWithSpread += 1;

          const buyPool = priceA < priceB ? poolB : poolA;
          const sellPool = priceA < priceB ? poolA : poolB;
          const buyPrice = priceA < priceB ? priceB : priceA;
          const sellPrice = priceA < priceB ? priceA : priceB;
          const bounds = this.computePairBorrowBounds(buyPool, sellPool, buyPrice, sellPrice);

          qualifiedPairs.push({ key: pairLabel, buyPool, sellPool, priceA: buyPrice, priceB: sellPrice, spreadBps, bounds });
        }
      }
    }

    // Phase B: Quote all qualified pairs in parallel (OPT-2)
    if (qualifiedPairs.length > 0) {
      const pairResults = await Promise.all(
        qualifiedPairs.map(async (qp) => {
          const bestResult = await this.findBestCandidate(qp.buyPool, qp.sellPool, qp.bounds);
          return { qp, bestResult };
        })
      );

      for (const { qp, bestResult } of pairResults) {
        const now = new Date().toISOString();
        optimizerRuns += 1;
        optimizerEvalCount += bestResult.optimizerMetrics.evaluationCount;
        optimizerCacheHits += bestResult.optimizerMetrics.cacheHits;
        if (bestResult.optimizerMetrics.budgetExhausted) {
          optimizerBudgetExhaustedCount += 1;
        }
        quoteRoundTripAttempts += bestResult.roundTripAttempts;
        quoteRoundTripFailures += bestResult.roundTripFailures;

        const best = bestResult.bestCandidate;
        if (!best) {
          this.emitPairTelemetry(now, blk, qp.key, qp.buyPool.dex, qp.sellPool.dex, qp.priceA, qp.priceB, qp.spreadBps, true, true, "optimizer_no_candidate", undefined, undefined, qp.bounds);
          continue;
        }

        if (best.profitToken0 < qp.bounds.minExpectedProfitToken0) {
          this.emitPairTelemetry(now, blk, qp.key, qp.buyPool.dex, qp.sellPool.dex, qp.priceA, qp.priceB, qp.spreadBps, true, true, "profit_below_min", best, qp.bounds.minExpectedProfitToken0, qp.bounds);
          continue;
        }

        this.emitPairTelemetry(now, blk, qp.key, qp.buyPool.dex, qp.sellPool.dex, qp.priceA, qp.priceB, qp.spreadBps, true, true, "accepted", best, qp.bounds.minExpectedProfitToken0, qp.bounds);

        const amountOutMinToken0 = estimateMinOutToken0(best.amountBackToken0, best.profitToken0, qp.bounds.minExpectedProfitToken0);

        const opportunity: Opportunity = {
          token0: qp.buyPool.token0,
          token1: qp.buyPool.token1,
          fee: qp.buyPool.fee,
          borrowDex: qp.buyPool.dex,
          buyPool: qp.buyPool,
          sellPool: qp.sellPool,
          grossSpreadBps: qp.spreadBps,
          estimatedBorrowAmountToken0: best.amountInToken0,
          amountOutMinToken0,
        };

        opportunities.push(opportunity);
        opportunitiesFound += 1;
      }
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
    };

    if (this.telemetry) {
      this.telemetry.recordBlock({
        timestamp: new Date().toISOString(),
        blockNumber: blockNumber ?? 0,
        pairsScanned,
        pairsWithSpread,
        opportunitiesFound,
        quoteRoundTripAttempts,
        quoteRoundTripFailures,
        detectDurationMs: this.metrics.durationMs,
      });
    }

    return opportunities;
  }

  private emitPairTelemetry(
    timestamp: string,
    blockNumber: number,
    pair: string,
    dexA: Dex,
    dexB: Dex,
    priceA: number,
    priceB: number,
    spreadBps: number,
    spreadAboveThreshold: boolean,
    quoteAttempted: boolean,
    rejectReason: TelemetryRecord["rejectReason"],
    candidate?: CandidateQuote,
    minExpectedProfitToken0?: bigint,
    pairBounds?: PairBorrowBounds
  ): void {
    if (!this.telemetry) return;

    this.telemetry.recordPair({
      timestamp,
      blockNumber,
      pair,
      dexA,
      dexB,
      priceA,
      priceB,
      spreadBps,
      spreadAboveThreshold,
      quoteAttempted,
      borrowAmount: candidate?.amountInToken0.toString(),
      firstLegOut: candidate?.amountOutToken1.toString(),
      secondLegOut: candidate?.amountBackToken0.toString(),
      expectedProfit: candidate?.profitToken0.toString(),
      profitAboveMin: candidate && minExpectedProfitToken0 !== undefined
        ? candidate.profitToken0 >= minExpectedProfitToken0
        : undefined,
      maxBorrowToken0: pairBounds?.maxBorrowToken0.toString(),
      liquidityCap: pairBounds?.liquidityCap?.toString(),
      rejectReason,
    });
  }

  private computePairBorrowBounds(buyPool: PoolState, sellPool: PoolState, uniPrice: number, pcsPrice: number): PairBorrowBounds {
    if (this.options.maxBorrowToken0 !== undefined && this.options.minExpectedProfitToken0 !== undefined) {
      return {
        maxBorrowToken0: this.options.maxBorrowToken0,
        minBorrowToken0: this.options.minBorrowToken0 ?? 10n ** 15n,
        minExpectedProfitToken0: this.options.minExpectedProfitToken0,
      };
    }

    const token0Decimals = getTokenDecimals(buyPool.token0);
    const decimalsFactor = 10 ** token0Decimals;

    const token0PriceUsd = this.deriveToken0PriceUsd(buyPool, uniPrice, pcsPrice);

    const maxBorrowUsd = this.options.maxBorrowAmountUsd;
    const maxBorrowToken0Float = token0PriceUsd > 0 ? maxBorrowUsd / token0PriceUsd : 0;
    let maxBorrowToken0 = maxBorrowToken0Float > 0
      ? BigInt(Math.floor(maxBorrowToken0Float * decimalsFactor))
      : BigInt(decimalsFactor);

    // Cap at 30% of the shallower pool's token0 depth to avoid catastrophic slippage
    const LIQUIDITY_CAP_BPS = 3000n;
    const buyToken0Available = estimateToken0Available(buyPool.sqrtPriceX96, buyPool.liquidity);
    const sellToken0Available = estimateToken0Available(sellPool.sqrtPriceX96, sellPool.liquidity);
    const minPoolToken0 = buyToken0Available < sellToken0Available ? buyToken0Available : sellToken0Available;
    const liquidityCap = (minPoolToken0 * LIQUIDITY_CAP_BPS) / 10_000n;

    if (liquidityCap > 0n && liquidityCap < maxBorrowToken0) {
      maxBorrowToken0 = liquidityCap;
    }

    const minBorrowFloat = 0.001;
    const minBorrowToken0 = this.options.minBorrowToken0
      ?? BigInt(Math.floor(minBorrowFloat * decimalsFactor));

    const minProfitUsd = this.options.minProfitThresholdUsd;
    const minProfitFloat = token0PriceUsd > 0 ? minProfitUsd / token0PriceUsd : 0;
    const minExpectedProfitToken0 = minProfitFloat > 0
      ? BigInt(Math.floor(minProfitFloat * decimalsFactor))
      : 10n ** BigInt(token0Decimals - 3);

    logger.debug("per-pair borrow bounds", {
      token0: buyPool.token0,
      token0PriceUsd: token0PriceUsd.toFixed(4),
      maxBorrowUsd,
      maxBorrowToken0: maxBorrowToken0.toString(),
      liquidityCap: liquidityCap.toString(),
      buyPoolToken0Avail: buyToken0Available.toString(),
      sellPoolToken0Avail: sellToken0Available.toString(),
      minBorrowToken0: minBorrowToken0.toString(),
      minProfitUsd,
      minExpectedProfitToken0: minExpectedProfitToken0.toString(),
    });

    return { maxBorrowToken0, minBorrowToken0, minExpectedProfitToken0, liquidityCap };
  }

  private deriveToken0PriceUsd(pool: PoolState, uniPrice: number, pcsPrice: number): number {
    const token0Lower = pool.token0.toLowerCase();
    const token1Lower = pool.token1.toLowerCase();

    if (isStablecoin(token0Lower)) {
      return 1.0;
    }

    if (isStablecoin(token1Lower)) {
      const avgPoolPrice = (uniPrice + pcsPrice) / 2;
      const token0Decimals = getTokenDecimals(pool.token0);
      const token1Decimals = getTokenDecimals(pool.token1);
      const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
      return avgPoolPrice * decimalAdjustment;
    }

    // Neither token is a stablecoin — fall back to conservative $1 estimate.
    // This is safe because it just means borrow bounds = maxBorrowAmountUsd tokens.
    return 1.0;
  }

  private async findBestCandidate(
    buyPool: PoolState,
    sellPool: PoolState,
    bounds: PairBorrowBounds
  ): Promise<{
    bestCandidate: CandidateQuote | null;
    optimizerMetrics: OptimizerMetrics;
    roundTripAttempts: number;
    roundTripFailures: number;
  }> {
    const factory = this.options.optimizerFactory ?? defaultOptimizerFactory;
    const optimizer: IOptimizer = factory({
      minAmountToken0: bounds.minBorrowToken0,
      maxAmountToken0: bounds.maxBorrowToken0,
    });

    let roundTripAttempts = 0;
    let roundTripFailures = 0;

    const { bestPoint, metrics } = await optimizer.optimize(
      async (amountInToken0) => {
        roundTripAttempts += 1;
        const quote = await this.quoteRoundTrip(buyPool, sellPool, amountInToken0);
        if (!quote) {
          roundTripFailures += 1;
        }
        return quote ? quote.profitToken0 : null;
      },
      async (amounts) => {
        roundTripAttempts += amounts.length;
        const profits = await this.batchQuoteRoundTrips(buyPool, sellPool, amounts);
        for (const p of profits) {
          if (p === null) roundTripFailures += 1;
        }
        return profits;
      }
    );

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
        poolId: isV4StyleDex(buyPool.dex) ? buyPool.poolAddress : undefined,
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
        poolId: isV4StyleDex(sellPool.dex) ? sellPool.poolAddress : undefined,
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

  private async batchQuoteRoundTrips(
    buyPool: PoolState,
    sellPool: PoolState,
    amounts: bigint[]
  ): Promise<(bigint | null)[]> {
    const buyPoolId = isV4StyleDex(buyPool.dex) ? buyPool.poolAddress : undefined;
    const sellPoolId = isV4StyleDex(sellPool.dex) ? sellPool.poolAddress : undefined;

    const leg1Requests = amounts.map((amountIn) => ({
      dex: buyPool.dex,
      tokenIn: buyPool.token0,
      tokenOut: buyPool.token1,
      fee: buyPool.fee,
      amountIn,
      poolId: buyPoolId,
    }));

    const leg1Results = await this.quoter.batchQuoteExactInputSingle(leg1Requests);

    const leg2Requests = leg1Results.map((r) => {
      if (!r || r.amountOut <= 0n) return null;
      return {
        dex: sellPool.dex,
        tokenIn: sellPool.token1,
        tokenOut: sellPool.token0,
        fee: sellPool.fee,
        amountIn: r.amountOut,
        poolId: sellPoolId,
      };
    });

    const validLeg2Requests = leg2Requests.filter((r): r is NonNullable<typeof r> => r !== null);
    const leg2IndexMap: number[] = [];
    for (let i = 0; i < leg2Requests.length; i++) {
      if (leg2Requests[i] !== null) leg2IndexMap.push(i);
    }

    const leg2Results = validLeg2Requests.length > 0
      ? await this.quoter.batchQuoteExactInputSingle(validLeg2Requests)
      : [];

    const profits: (bigint | null)[] = new Array(amounts.length).fill(null);
    for (let j = 0; j < leg2IndexMap.length; j++) {
      const origIdx = leg2IndexMap[j];
      const leg2 = leg2Results[j];
      if (leg2 && leg2.amountOut > 0n) {
        profits[origIdx] = leg2.amountOut - amounts[origIdx];
      }
    }

    return profits;
  }
}
