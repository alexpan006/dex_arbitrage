import { expect } from "chai";
import { AdaptiveGridOptimizer, AdaptiveGridOptimizerOptions } from "../../src/strategy/AdaptiveGridOptimizer";

const MIN_AMOUNT = 100n;
const MAX_AMOUNT = 100_000n; // e.g. $100K in token0 units

function makeOptimizer(overrides: Partial<AdaptiveGridOptimizerOptions> = {}): AdaptiveGridOptimizer {
  return new AdaptiveGridOptimizer({
    minAmountToken0: MIN_AMOUNT,
    maxAmountToken0: MAX_AMOUNT,
    ...overrides,
  });
}

function makeQuadraticProfit(peakAmount: bigint, maxProfit: bigint) {
  return (amountInToken0: bigint): bigint => {
    const delta = amountInToken0 - peakAmount;
    return maxProfit - (delta * delta);
  };
}

describe("AdaptiveGridOptimizer", function () {
  it("grid sweep evaluates all default ratios and picks correct best", async function () {
    const optimizer = makeOptimizer();
    const calls: bigint[] = [];
    // Peak at 700 bps → 7000 tokens (7% of 100K)
    const evaluate = makeQuadraticProfit(7000n, 1_000_000n);

    const result = await optimizer.optimize(async (amount) => {
      calls.push(amount);
      return evaluate(amount);
    });

    // Default grid: [10, 50, 100, 300, 700, 1500, 3500, 6500, 9000] bps
    // → amounts: [100, 500, 1000, 3000, 7000, 15000, 35000, 65000, 90000]
    // But 10 bps of 100K = 100, which equals MIN_AMOUNT, so it clamps to 100
    expect(calls.length).to.equal(9);
    expect(result.bestPoint).to.not.be.null;
    expect(result.bestPoint!.amountInToken0).to.equal(7000n);
    expect(result.metrics.gridPointCount).to.equal(9);
    expect(result.metrics.evaluationCount).to.equal(9);
    expect(result.metrics.budgetExhausted).to.be.false;
  });

  it("log-scale grid covers small amounts that linear grid misses", async function () {
    const optimizer = makeOptimizer();
    const calls: bigint[] = [];
    // Peak at tiny amount — 500 tokens (0.5% of 100K)
    const evaluate = makeQuadraticProfit(500n, 1_000_000n);

    const result = await optimizer.optimize(async (amount) => {
      calls.push(amount);
      return evaluate(amount);
    });

    expect(result.bestPoint).to.not.be.null;
    // Grid has 50 bps → 500 tokens, should hit the peak exactly
    expect(result.bestPoint!.amountInToken0).to.equal(500n);
    // Verify small amounts were evaluated
    expect(calls).to.include(100n);  // 10 bps
    expect(calls).to.include(500n);  // 50 bps
    expect(calls).to.include(1000n); // 100 bps
  });

  it("exits with null when all evaluations return null", async function () {
    const optimizer = makeOptimizer();

    const result = await optimizer.optimize(async () => null);

    expect(result.bestPoint).to.be.null;
    expect(result.metrics.gridPointCount).to.equal(0);
    expect(result.metrics.evaluationCount).to.equal(9);
  });

  it("budget exhaustion when grid exceeds maxQuoteEvaluations", async function () {
    const optimizer = makeOptimizer({ maxQuoteEvaluations: 4 });
    let evalCount = 0;

    const result = await optimizer.optimize(async (amount) => {
      evalCount += 1;
      return amount; // linear profit
    });

    expect(evalCount).to.equal(4);
    expect(result.metrics.evaluationCount).to.equal(4);
    expect(result.metrics.budgetExhausted).to.be.true;
    expect(result.bestPoint).to.not.be.null;
  });

  it("deduplicates clamped amounts", async function () {
    // With a small maxAmount, multiple grid ratios will clamp to minAmount
    const optimizer = makeOptimizer({
      minAmountToken0: 500n,
      maxAmountToken0: 1000n,
      gridRatiosBps: [10, 50, 100, 300, 5000, 9000],
    });
    const calls: bigint[] = [];

    const result = await optimizer.optimize(async (amount) => {
      calls.push(amount);
      return amount; // linear
    });

    // 10 bps → 0 → clamp to 500
    // 50 bps → 5 → clamp to 500
    // 100 bps → 10 → clamp to 500 (dedup)
    // 300 bps → 30 → clamp to 500 (dedup)
    // 5000 bps → 500 (dedup with 500)
    // 9000 bps → 900
    // Unique: [500, 900]
    expect(calls).to.deep.equal([500n, 900n]);
    expect(result.metrics.evaluationCount).to.equal(2);
    expect(result.metrics.cacheHits).to.equal(4);
    expect(result.bestPoint!.amountInToken0).to.equal(900n);
  });

  it("custom grid ratios override defaults", async function () {
    const customGrid = [2500, 5000, 7500];
    const optimizer = makeOptimizer({ gridRatiosBps: customGrid });
    const calls: bigint[] = [];

    const result = await optimizer.optimize(async (amount) => {
      calls.push(amount);
      return makeQuadraticProfit(50000n, 1_000_000n)(amount);
    });

    expect(calls).to.deep.equal([25000n, 50000n, 75000n]);
    expect(result.bestPoint!.amountInToken0).to.equal(50000n);
    expect(result.metrics.gridPointCount).to.equal(3);
  });

  describe("batch evaluator", function () {
    it("uses batch evaluator and picks correct best", async function () {
      const optimizer = makeOptimizer({ gridRatiosBps: [1000, 3000, 5000, 9000] });
      const evaluate = makeQuadraticProfit(30000n, 1_000_000n);
      let batchCalls = 0;
      let singleCalls = 0;

      const result = await optimizer.optimize(
        async (amount) => { singleCalls += 1; return evaluate(amount); },
        async (amounts) => { batchCalls += 1; return amounts.map((a) => evaluate(a)); }
      );

      expect(batchCalls).to.equal(1);
      expect(singleCalls).to.equal(0);
      expect(result.bestPoint).to.not.be.null;
      expect(result.bestPoint!.amountInToken0).to.equal(30000n);
    });

    it("handles mixed null results from batch evaluator", async function () {
      const optimizer = makeOptimizer({ gridRatiosBps: [1000, 3000, 5000, 9000] });
      const evaluate = makeQuadraticProfit(50000n, 1_000_000n);

      const result = await optimizer.optimize(
        async (amount) => evaluate(amount),
        async (amounts) => amounts.map((a) => a === 30000n ? null : evaluate(a))
      );

      expect(result.bestPoint).to.not.be.null;
      expect(result.metrics.gridPointCount).to.equal(3);
    });

    it("respects budget cap in batch mode", async function () {
      const optimizer = makeOptimizer({
        gridRatiosBps: [1000, 3000, 5000, 7000, 9000],
        maxQuoteEvaluations: 3,
      });
      let batchedAmounts: bigint[] = [];

      const result = await optimizer.optimize(
        async (amount) => amount,
        async (amounts) => { batchedAmounts = amounts; return amounts.map((a) => a); }
      );

      expect(batchedAmounts).to.have.length(3);
      expect(result.metrics.evaluationCount).to.equal(3);
      expect(result.metrics.budgetExhausted).to.be.true;
    });

    it("produces same best point as sequential", async function () {
      const evaluate = makeQuadraticProfit(15000n, 1_000_000n);
      const opts: Partial<AdaptiveGridOptimizerOptions> = {
        gridRatiosBps: [500, 1500, 3000, 5000, 8000],
      };

      const seqResult = await makeOptimizer(opts).optimize(
        async (amount) => evaluate(amount)
      );
      const batchResult = await makeOptimizer(opts).optimize(
        async (amount) => evaluate(amount),
        async (amounts) => amounts.map((a) => evaluate(a))
      );

      expect(batchResult.bestPoint).to.not.be.null;
      expect(seqResult.bestPoint).to.not.be.null;
      expect(batchResult.bestPoint!.amountInToken0).to.equal(seqResult.bestPoint!.amountInToken0);
      expect(batchResult.bestPoint!.profitToken0).to.equal(seqResult.bestPoint!.profitToken0);
    });
  });
});
