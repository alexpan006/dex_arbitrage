import { DetectorRunMetrics } from "../strategy/OpportunityDetector";

export interface RollingDetectorSummary {
  windowMs: number;
  sampleCount: number;
  sinceMs: number;
  untilMs: number;
  avgDetectDurationMs: number;
  avgPairsScanned: number;
  avgPairsWithSpread: number;
  avgOpportunitiesFound: number;
  avgQuoteRoundTripAttempts: number;
  quoteRoundTripFailureRate: number;
  avgOptimizerEvalCount: number;
  avgOptimizerCacheHits: number;
  optimizerBudgetExhaustedRate: number;
}

function safeAverage(total: number, count: number): number {
  return count > 0 ? total / count : 0;
}

export class RollingDetectorMetrics {
  private readonly windowMs: number;
  private readonly samples: DetectorRunMetrics[] = [];

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  add(sample: DetectorRunMetrics): void {
    this.samples.push(sample);
    this.prune(sample.finishedAtMs);
  }

  getSummary(nowMs = Date.now()): RollingDetectorSummary {
    this.prune(nowMs);

    const sampleCount = this.samples.length;
    const sinceMs = sampleCount > 0 ? this.samples[0].startedAtMs : nowMs;
    const untilMs = sampleCount > 0 ? this.samples[sampleCount - 1].finishedAtMs : nowMs;

    let totalDuration = 0;
    let totalPairsScanned = 0;
    let totalPairsWithSpread = 0;
    let totalOpportunities = 0;
    let totalQuoteAttempts = 0;
    let totalQuoteFailures = 0;
    let totalOptimizerEval = 0;
    let totalOptimizerCacheHits = 0;
    let totalOptimizerRuns = 0;
    let totalOptimizerBudgetExhausted = 0;

    for (const sample of this.samples) {
      totalDuration += sample.durationMs;
      totalPairsScanned += sample.pairsScanned;
      totalPairsWithSpread += sample.pairsWithSpread;
      totalOpportunities += sample.opportunitiesFound;
      totalQuoteAttempts += sample.quoteRoundTripAttempts;
      totalQuoteFailures += sample.quoteRoundTripFailures;
      totalOptimizerEval += sample.optimizerEvalCount;
      totalOptimizerCacheHits += sample.optimizerCacheHits;
      totalOptimizerRuns += sample.optimizerRuns;
      totalOptimizerBudgetExhausted += sample.optimizerBudgetExhaustedCount;
    }

    return {
      windowMs: this.windowMs,
      sampleCount,
      sinceMs,
      untilMs,
      avgDetectDurationMs: safeAverage(totalDuration, sampleCount),
      avgPairsScanned: safeAverage(totalPairsScanned, sampleCount),
      avgPairsWithSpread: safeAverage(totalPairsWithSpread, sampleCount),
      avgOpportunitiesFound: safeAverage(totalOpportunities, sampleCount),
      avgQuoteRoundTripAttempts: safeAverage(totalQuoteAttempts, sampleCount),
      quoteRoundTripFailureRate: totalQuoteAttempts > 0 ? totalQuoteFailures / totalQuoteAttempts : 0,
      avgOptimizerEvalCount: safeAverage(totalOptimizerEval, sampleCount),
      avgOptimizerCacheHits: safeAverage(totalOptimizerCacheHits, sampleCount),
      optimizerBudgetExhaustedRate: totalOptimizerRuns > 0 ? totalOptimizerBudgetExhausted / totalOptimizerRuns : 0,
    };
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.samples.length > 0 && this.samples[0].finishedAtMs < cutoff) {
      this.samples.shift();
    }
  }
}
