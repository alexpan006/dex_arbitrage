import { expect } from "chai";
import { HybridAmountOptimizer, HybridAmountOptimizerOptions } from "../../src/strategy/HybridAmountOptimizer";

const MIN_AMOUNT = 100n;
const MAX_AMOUNT = 1000n;

function makeOptimizer(overrides: Partial<HybridAmountOptimizerOptions> = {}): HybridAmountOptimizer {
  return new HybridAmountOptimizer({
    minAmountToken0: MIN_AMOUNT,
    maxAmountToken0: MAX_AMOUNT,
    coarseRatiosBps: [1500, 3500, 5500, 7500, 9000],
    maxQuoteEvaluations: 13,
    ...overrides,
  });
}

function makeQuadraticProfit(peakAmount: bigint, maxProfit: bigint) {
  return (amountInToken0: bigint): bigint => {
    const delta = amountInToken0 - peakAmount;
    return maxProfit - (delta * delta);
  };
}

function coarseAmounts(maxAmountToken0: bigint, ratiosBps: number[]): bigint[] {
  return ratiosBps.map((bps) => (maxAmountToken0 * BigInt(bps)) / 10_000n);
}

describe("HybridAmountOptimizer", function () {
  it("grid sweep evaluates all ratios and picks correct best", async function () {
    const coarseRatiosBps = [1500, 3500, 5500, 7500, 9000];
    const optimizer = makeOptimizer({ coarseRatiosBps });
    const calls: bigint[] = [];
    const evaluate = makeQuadraticProfit(900n, 1_000_000n);

    const result = await optimizer.optimize(async (amount) => {
      calls.push(amount);
      return evaluate(amount);
    });

    expect(calls).to.deep.equal(coarseAmounts(MAX_AMOUNT, coarseRatiosBps));
    expect(result.bestPoint).to.not.be.null;
    expect(result.bestPoint!.amountInToken0).to.equal(900n);
    expect(result.metrics.evaluationCount).to.equal(coarseRatiosBps.length);
    expect(result.metrics.gridPointCount).to.equal(coarseRatiosBps.length);
  });

  it("exits early when all coarse profits are non-positive", async function () {
    const coarseRatiosBps = [1000, 3500, 9000];
    const optimizer = makeOptimizer({ coarseRatiosBps });
    let evalCount = 0;

    const result = await optimizer.optimize(async (amount) => {
      evalCount += 1;
      return -amount;
    });

    expect(result.bestPoint).to.not.be.null;
    expect(result.bestPoint!.profitToken0).to.be.at.most(0n);
    expect(evalCount).to.equal(coarseRatiosBps.length);
    expect(result.metrics.evaluationCount).to.equal(coarseRatiosBps.length);
  });

  it("stops at budget cap and marks budget exhausted", async function () {
    const coarseRatiosBps = [1500, 3500, 5500, 7500, 9000];
    const maxQuoteEvaluations = 3;
    const optimizer = makeOptimizer({
      coarseRatiosBps,
      maxQuoteEvaluations,
    });
    let evalCount = 0;

    const result = await optimizer.optimize(async (amount) => {
      evalCount += 1;
      return makeQuadraticProfit(900n, 1_000_000n)(amount);
    });

    expect(evalCount).to.equal(maxQuoteEvaluations);
    expect(result.metrics.evaluationCount).to.equal(maxQuoteEvaluations);
    expect(result.metrics.budgetExhausted).to.be.true;
  });

  it("deduplicates cached evaluations when coarse ratios clamp to same amount", async function () {
    const coarseRatiosBps = [1000, 1001, 2000];
    const optimizer = makeOptimizer({
      coarseRatiosBps,
    });
    const calls: bigint[] = [];

    const result = await optimizer.optimize(async (amount) => {
      calls.push(amount);
      return makeQuadraticProfit(200n, 1_000_000n)(amount);
    });

    expect(calls).to.deep.equal([100n, 200n]);
    expect(result.metrics.evaluationCount).to.equal(2);
    expect(result.metrics.cacheHits).to.equal(1);
    expect(result.metrics.gridPointCount).to.equal(3);
  });

  it("handles null evaluator returns gracefully", async function () {
    const optimizer = makeOptimizer({
      coarseRatiosBps: [1000, 2000, 3500, 5000],
      maxQuoteEvaluations: 16,
    });

    const result = await optimizer.optimize(async (amount) => {
      if (amount === 200n) {
        return null;
      }
      return makeQuadraticProfit(900n, 1_000_000n)(amount);
    });

    expect(result.bestPoint).to.not.be.null;
    expect(result.metrics.gridPointCount).to.equal(3);
  });

  it("works with a single coarse point", async function () {
    const optimizer = makeOptimizer({
      coarseRatiosBps: [5000],
      maxQuoteEvaluations: 16,
    });
    let evalCount = 0;

    const result = await optimizer.optimize(async (amount) => {
      evalCount += 1;
      return makeQuadraticProfit(700n, 1_000_000n)(amount);
    });

    expect(result.bestPoint).to.not.be.null;
    expect(result.metrics.gridPointCount).to.equal(1);
    expect(evalCount).to.equal(1);
    expect(result.metrics.evaluationCount).to.equal(1);
  });

  it("reports metrics consistently for evaluation/cache/budget fields", async function () {
    const optimizer = makeOptimizer({
      coarseRatiosBps: [1000, 3500, 9000],
      maxQuoteEvaluations: 16,
    });
    const evaluate = makeQuadraticProfit(450n, 1_000_000n);

    const result = await optimizer.optimize(async (amount) => evaluate(amount));

    expect(result.metrics.evaluationCount).to.equal(3);
    expect(result.metrics.cacheHits).to.equal(0);
    expect(result.metrics.gridPointCount).to.equal(3);
    expect(result.metrics.budgetExhausted).to.be.false;
  });

  describe("batch evaluator", function () {
    it("uses batch evaluator for grid phase", async function () {
      const optimizer = makeOptimizer({
        coarseRatiosBps: [1000, 3500, 9000],
        maxQuoteEvaluations: 16,
      });
      const evaluate = makeQuadraticProfit(450n, 1_000_000n);
      let batchCalls = 0;
      let singleCalls = 0;

      const result = await optimizer.optimize(
        async (amount) => { singleCalls += 1; return evaluate(amount); },
        async (amounts) => { batchCalls += 1; return amounts.map((a) => evaluate(a)); }
      );

      expect(batchCalls).to.equal(1);
      expect(singleCalls).to.equal(0);
      expect(result.bestPoint).to.not.be.null;
      expect(result.metrics.gridPointCount).to.equal(3);
    });

    it("produces same best point as sequential for quadratic profit curve", async function () {
      const evaluate = makeQuadraticProfit(600n, 1_000_000n);
      const opts: Partial<HybridAmountOptimizerOptions> = {
        coarseRatiosBps: [1500, 3500, 5500, 7500, 9000],
        maxQuoteEvaluations: 13,
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

    it("handles mixed null results from batch evaluator", async function () {
      const optimizer = makeOptimizer({
        coarseRatiosBps: [1000, 3500, 5000, 9000],
        maxQuoteEvaluations: 16,
      });
      const evaluate = makeQuadraticProfit(500n, 1_000_000n);

      const result = await optimizer.optimize(
        async (amount) => evaluate(amount),
        async (amounts) => amounts.map((a) => a === 350n ? null : evaluate(a))
      );

      expect(result.bestPoint).to.not.be.null;
      expect(result.metrics.gridPointCount).to.equal(3);
    });

    it("falls back to sequential when batch evaluator is not provided", async function () {
      const optimizer = makeOptimizer({ coarseRatiosBps: [1500, 5000, 9000] });
      const calls: bigint[] = [];
      const evaluate = makeQuadraticProfit(500n, 1_000_000n);

      const result = await optimizer.optimize(async (amount) => {
        calls.push(amount);
        return evaluate(amount);
      });

      expect(calls).to.have.length(3);
      expect(result.bestPoint).to.not.be.null;
      expect(result.metrics.gridPointCount).to.equal(3);
    });

    it("deduplicates amounts in batch mode when coarse ratios clamp to same value", async function () {
      const optimizer = makeOptimizer({
        coarseRatiosBps: [1000, 1001, 5000],
        maxQuoteEvaluations: 16,
      });
      let batchedAmounts: bigint[] = [];
      const evaluate = makeQuadraticProfit(500n, 1_000_000n);

      const result = await optimizer.optimize(
        async (amount) => evaluate(amount),
        async (amounts) => { batchedAmounts = amounts; return amounts.map((a) => evaluate(a)); }
      );

      expect(batchedAmounts).to.deep.equal([100n, 500n]);
      expect(result.metrics.evaluationCount).to.equal(2);
      expect(result.metrics.cacheHits).to.equal(1);
      expect(result.metrics.gridPointCount).to.equal(2);
    });
  });
});
