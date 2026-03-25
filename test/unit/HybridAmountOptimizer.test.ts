import { expect } from "chai";
import { HybridAmountOptimizer, HybridAmountOptimizerOptions } from "../../src/strategy/HybridAmountOptimizer";

const MIN_AMOUNT = 100n;
const MAX_AMOUNT = 1000n;

function makeOptimizer(overrides: Partial<HybridAmountOptimizerOptions> = {}): HybridAmountOptimizer {
  return new HybridAmountOptimizer({
    minAmountToken0: MIN_AMOUNT,
    maxAmountToken0: MAX_AMOUNT,
    coarseRatiosBps: [1500, 3500, 5500, 7500, 9000],
    refineIterations: 4,
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
  it("coarse sweep evaluates all coarse ratios and picks correct best", async function () {
    const coarseRatiosBps = [1500, 3500, 5500, 7500, 9000];
    const optimizer = makeOptimizer({ coarseRatiosBps, refineIterations: 0 });
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
    expect(result.metrics.coarsePointCount).to.equal(coarseRatiosBps.length);
    expect(result.metrics.parabolicTried).to.be.false;
  });

  it("exits early when all coarse profits are non-positive", async function () {
    const coarseRatiosBps = [1000, 3500, 9000];
    const optimizer = makeOptimizer({ coarseRatiosBps, refineIterations: 4 });
    let evalCount = 0;

    const result = await optimizer.optimize(async (amount) => {
      evalCount += 1;
      return -amount;
    });

    expect(result.bestPoint).to.not.be.null;
    expect(result.bestPoint!.profitToken0).to.be.at.most(0n);
    expect(evalCount).to.equal(coarseRatiosBps.length);
    expect(result.metrics.evaluationCount).to.equal(coarseRatiosBps.length);
    expect(result.metrics.parabolicTried).to.be.false;
    expect(result.metrics.refineIterationsExecuted).to.equal(0);
  });

  it("tries and accepts parabolic interpolation when it improves best point", async function () {
    const optimizer = makeOptimizer({
      coarseRatiosBps: [1000, 3500, 9000],
      refineIterations: 0,
    });
    const evaluate = makeQuadraticProfit(450n, 1_000_000n);

    const result = await optimizer.optimize(async (amount) => evaluate(amount));

    expect(result.bestPoint).to.not.be.null;
    expect(result.metrics.parabolicTried).to.be.true;
    expect(result.metrics.parabolicAccepted).to.be.true;
    expect(result.metrics.evaluationCount).to.equal(4);
    expect(result.bestPoint!.amountInToken0).to.be.greaterThan(350n);
    expect(result.bestPoint!.amountInToken0).to.be.lessThan(900n);
    expect(result.bestPoint!.profitToken0).to.be.greaterThan(evaluate(350n));
  });

  it("skips parabolic interpolation when coarse best is at an edge", async function () {
    const options = { coarseRatiosBps: [1000, 3500, 9000], refineIterations: 0 };

    const leftEdge = await makeOptimizer(options).optimize(async (amount) => makeQuadraticProfit(100n, 1_000_000n)(amount));
    expect(leftEdge.bestPoint).to.not.be.null;
    expect(leftEdge.bestPoint!.amountInToken0).to.equal(100n);
    expect(leftEdge.metrics.parabolicTried).to.be.false;
    expect(leftEdge.metrics.evaluationCount).to.equal(3);

    const rightEdge = await makeOptimizer(options).optimize(async (amount) => makeQuadraticProfit(900n, 1_000_000n)(amount));
    expect(rightEdge.bestPoint).to.not.be.null;
    expect(rightEdge.bestPoint!.amountInToken0).to.equal(900n);
    expect(rightEdge.metrics.parabolicTried).to.be.false;
    expect(rightEdge.metrics.evaluationCount).to.equal(3);
  });

  it("rejects invalid parabolic vertex (null solver result) without extra evaluation", async function () {
    const optimizer = makeOptimizer({
      coarseRatiosBps: [1000, 3500, 9000],
      refineIterations: 0,
    });
    const calls: bigint[] = [];

    const huge = 10n ** 400n;
    const result = await optimizer.optimize(async (amount) => {
      calls.push(amount);
      if (amount === 350n) {
        return huge * 10n;
      }
      return huge;
    });

    expect(result.metrics.parabolicTried).to.be.true;
    expect(result.metrics.parabolicAccepted).to.be.false;
    expect(result.metrics.evaluationCount).to.equal(3);
    expect(calls).to.deep.equal([100n, 350n, 900n]);
  });

  it("runs golden-section with one new evaluation per iteration after initialization", async function () {
    const coarseRatiosBps = [1000, 5000, 9000];
    const refineIterations = 4;
    const optimizer = makeOptimizer({
      coarseRatiosBps,
      refineIterations,
      maxQuoteEvaluations: 32,
    });
    const calls: bigint[] = [];
    const evaluate = makeQuadraticProfit(1000n, 1_000_000n);

    const result = await optimizer.optimize(async (amount) => {
      calls.push(amount);
      return evaluate(amount);
    });

    const expectedCoarse = coarseAmounts(MAX_AMOUNT, coarseRatiosBps);
    const gssCalls = calls.slice(expectedCoarse.length);

    expect(calls.slice(0, expectedCoarse.length)).to.deep.equal(expectedCoarse);
    expect(result.metrics.parabolicTried).to.be.false;
    expect(result.metrics.refineIterationsExecuted).to.equal(refineIterations);
    expect(gssCalls).to.have.length(2 + (refineIterations - 1));
    expect(result.metrics.evaluationCount).to.equal(expectedCoarse.length + gssCalls.length);
    expect(result.bestPoint).to.not.be.null;
    expect(result.bestPoint!.amountInToken0).to.be.greaterThan(900n);
    for (const amount of gssCalls) {
      expect(amount).to.be.greaterThan(500n);
      expect(amount).to.be.lessThan(1000n);
    }
  });

  it("stops at budget cap after coarse sweep and marks budget exhausted", async function () {
    const coarseRatiosBps = [1500, 3500, 5500, 7500, 9000];
    const maxQuoteEvaluations = 5;
    const optimizer = makeOptimizer({
      coarseRatiosBps,
      refineIterations: 4,
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
    expect(result.metrics.refineIterationsExecuted).to.equal(1);
  });

  it("deduplicates cached evaluations when coarse ratios clamp to same amount", async function () {
    const coarseRatiosBps = [1000, 1001, 2000];
    const optimizer = makeOptimizer({
      coarseRatiosBps,
      refineIterations: 0,
    });
    const calls: bigint[] = [];

    const result = await optimizer.optimize(async (amount) => {
      calls.push(amount);
      return makeQuadraticProfit(200n, 1_000_000n)(amount);
    });

    expect(calls).to.deep.equal([100n, 200n]);
    expect(result.metrics.evaluationCount).to.equal(2);
    expect(result.metrics.cacheHits).to.equal(1);
    expect(result.metrics.coarsePointCount).to.equal(3);
  });

  it("handles null evaluator returns gracefully", async function () {
    const optimizer = makeOptimizer({
      coarseRatiosBps: [1000, 2000, 3500, 5000],
      refineIterations: 2,
      maxQuoteEvaluations: 16,
    });

    const result = await optimizer.optimize(async (amount) => {
      if (amount === 200n || amount === 598n) {
        return null;
      }
      return makeQuadraticProfit(900n, 1_000_000n)(amount);
    });

    expect(result.bestPoint).to.not.be.null;
    expect(result.metrics.evaluationCount).to.equal(7);
    expect(result.metrics.coarsePointCount).to.equal(3);
    expect(result.metrics.refineIterationsExecuted).to.equal(2);
  });

  it("works with a single coarse point and still performs refinement", async function () {
    const optimizer = makeOptimizer({
      coarseRatiosBps: [5000],
      refineIterations: 3,
      maxQuoteEvaluations: 16,
    });
    let evalCount = 0;

    const result = await optimizer.optimize(async (amount) => {
      evalCount += 1;
      return makeQuadraticProfit(700n, 1_000_000n)(amount);
    });

    expect(result.bestPoint).to.not.be.null;
    expect(result.metrics.coarsePointCount).to.equal(1);
    expect(result.metrics.parabolicTried).to.be.false;
    expect(result.metrics.refineIterationsExecuted).to.equal(3);
    expect(evalCount).to.equal(5);
    expect(result.metrics.evaluationCount).to.equal(5);
  });

  it("reports metrics consistently for evaluation/cache/parabolic/refine/budget fields", async function () {
    const optimizer = makeOptimizer({
      coarseRatiosBps: [1000, 3500, 9000],
      refineIterations: 2,
      maxQuoteEvaluations: 16,
    });
    const evaluate = makeQuadraticProfit(450n, 1_000_000n);

    const result = await optimizer.optimize(async (amount) => evaluate(amount));

    expect(result.metrics.evaluationCount).to.equal(7);
    expect(result.metrics.cacheHits).to.equal(0);
    expect(result.metrics.coarsePointCount).to.equal(3);
    expect(result.metrics.parabolicTried).to.be.true;
    expect(result.metrics.parabolicAccepted).to.be.true;
    expect(result.metrics.refineIterationsExecuted).to.equal(2);
    expect(result.metrics.budgetExhausted).to.be.false;
  });

  describe("batch evaluator", function () {
    it("uses batch evaluator for coarse phase and single evaluator for refinement", async function () {
      const optimizer = makeOptimizer({
        coarseRatiosBps: [1000, 3500, 9000],
        refineIterations: 2,
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
      expect(singleCalls).to.be.greaterThan(0);
      expect(result.bestPoint).to.not.be.null;
      expect(result.metrics.coarsePointCount).to.equal(3);
      expect(result.metrics.parabolicTried).to.be.true;
    });

    it("produces same best point as sequential for quadratic profit curve", async function () {
      const evaluate = makeQuadraticProfit(600n, 1_000_000n);
      const opts = {
        coarseRatiosBps: [1500, 3500, 5500, 7500, 9000],
        refineIterations: 4,
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
        refineIterations: 0,
        maxQuoteEvaluations: 16,
      });
      const evaluate = makeQuadraticProfit(500n, 1_000_000n);

      const result = await optimizer.optimize(
        async (amount) => evaluate(amount),
        async (amounts) => amounts.map((a) => a === 350n ? null : evaluate(a))
      );

      expect(result.bestPoint).to.not.be.null;
      expect(result.metrics.coarsePointCount).to.equal(3);
    });

    it("falls back to sequential when batch evaluator is not provided", async function () {
      const optimizer = makeOptimizer({ coarseRatiosBps: [1500, 5000, 9000], refineIterations: 0 });
      const calls: bigint[] = [];
      const evaluate = makeQuadraticProfit(500n, 1_000_000n);

      const result = await optimizer.optimize(async (amount) => {
        calls.push(amount);
        return evaluate(amount);
      });

      expect(calls).to.have.length(3);
      expect(result.bestPoint).to.not.be.null;
      expect(result.metrics.coarsePointCount).to.equal(3);
    });

    it("deduplicates amounts in batch mode when coarse ratios clamp to same value", async function () {
      const optimizer = makeOptimizer({
        coarseRatiosBps: [1000, 1001, 5000],
        refineIterations: 0,
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
      expect(result.metrics.coarsePointCount).to.equal(2);
    });
  });
});
