import { expect } from "chai";
import { RollingDetectorMetrics } from "../../src/monitoring/RollingDetectorMetrics";
import { DetectorRunMetrics } from "../../src/strategy/OpportunityDetector";

function makeSample(overrides: Partial<DetectorRunMetrics> = {}): DetectorRunMetrics {
  return {
    startedAtMs: 1000,
    finishedAtMs: 1050,
    durationMs: 50,
    pairsScanned: 10,
    pairsWithSpread: 2,
    opportunitiesFound: 1,
    quoteRoundTripAttempts: 5,
    quoteRoundTripFailures: 1,
    optimizerRuns: 2,
    optimizerEvalCount: 8,
    optimizerCacheHits: 3,
    optimizerBudgetExhaustedCount: 0,
    optimizerParabolicAcceptedCount: 1,
    ...overrides,
  };
}

describe("RollingDetectorMetrics", function () {
  describe("empty state", function () {
    it("returns zeroed summary when no samples added", function () {
      const rolling = new RollingDetectorMetrics(60_000);
      const summary = rolling.getSummary(5000);

      expect(summary.sampleCount).to.equal(0);
      expect(summary.avgDetectDurationMs).to.equal(0);
      expect(summary.avgPairsScanned).to.equal(0);
      expect(summary.quoteRoundTripFailureRate).to.equal(0);
    });
  });

  describe("single sample", function () {
    it("computes averages from one sample", function () {
      const rolling = new RollingDetectorMetrics(60_000);
      rolling.add(makeSample({ durationMs: 42, pairsScanned: 7 }));

      const summary = rolling.getSummary(2000);
      expect(summary.sampleCount).to.equal(1);
      expect(summary.avgDetectDurationMs).to.equal(42);
      expect(summary.avgPairsScanned).to.equal(7);
    });
  });

  describe("multiple samples", function () {
    it("averages across samples", function () {
      const rolling = new RollingDetectorMetrics(60_000);
      rolling.add(makeSample({ finishedAtMs: 1000, durationMs: 40, pairsScanned: 10 }));
      rolling.add(makeSample({ finishedAtMs: 2000, durationMs: 60, pairsScanned: 20 }));

      const summary = rolling.getSummary(3000);
      expect(summary.sampleCount).to.equal(2);
      expect(summary.avgDetectDurationMs).to.equal(50);
      expect(summary.avgPairsScanned).to.equal(15);
    });
  });

  describe("window pruning", function () {
    it("drops samples older than window", function () {
      const rolling = new RollingDetectorMetrics(5000);
      rolling.add(makeSample({ finishedAtMs: 1000, durationMs: 10 }));
      rolling.add(makeSample({ finishedAtMs: 5000, durationMs: 20 }));
      rolling.add(makeSample({ finishedAtMs: 8000, durationMs: 30 }));

      const summary = rolling.getSummary(9000);
      expect(summary.sampleCount).to.equal(2);
      expect(summary.avgDetectDurationMs).to.equal(25);
    });

    it("handles all samples pruned", function () {
      const rolling = new RollingDetectorMetrics(1000);
      rolling.add(makeSample({ finishedAtMs: 100 }));

      const summary = rolling.getSummary(5000);
      expect(summary.sampleCount).to.equal(0);
    });
  });

  describe("rate calculations", function () {
    it("computes quote failure rate", function () {
      const rolling = new RollingDetectorMetrics(60_000);
      rolling.add(makeSample({
        finishedAtMs: 1000,
        quoteRoundTripAttempts: 10,
        quoteRoundTripFailures: 3,
      }));
      rolling.add(makeSample({
        finishedAtMs: 2000,
        quoteRoundTripAttempts: 10,
        quoteRoundTripFailures: 7,
      }));

      const summary = rolling.getSummary(3000);
      expect(summary.quoteRoundTripFailureRate).to.equal(0.5);
    });

    it("computes budget exhaustion rate", function () {
      const rolling = new RollingDetectorMetrics(60_000);
      rolling.add(makeSample({
        finishedAtMs: 1000,
        optimizerRuns: 4,
        optimizerBudgetExhaustedCount: 1,
      }));
      rolling.add(makeSample({
        finishedAtMs: 2000,
        optimizerRuns: 6,
        optimizerBudgetExhaustedCount: 3,
      }));

      const summary = rolling.getSummary(3000);
      expect(summary.optimizerBudgetExhaustedRate).to.equal(0.4);
    });
  });
});
