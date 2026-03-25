import { expect } from "chai";
import {
  estimateToken0Available,
  sqrtPriceX96ToPriceFloat,
  relativeDiffBps,
  absBigInt,
  minBigInt,
  clamp,
} from "../../src/utils/math";

const Q96 = 2n ** 96n;

describe("Math utils", () => {
  describe("estimateToken0Available", () => {
    it("returns L * 2^96 / sqrtPriceX96 for valid inputs", () => {
      // sqrtPriceX96 = Q96 → sqrtPrice = 1 → token0 = L
      const liquidity = 1000n * 10n ** 18n;
      const result = estimateToken0Available(Q96, liquidity);
      expect(result).to.equal(liquidity);
    });

    it("returns 0 when sqrtPriceX96 is 0", () => {
      expect(estimateToken0Available(0n, 1000n)).to.equal(0n);
    });

    it("returns 0 when liquidity is 0", () => {
      expect(estimateToken0Available(Q96, 0n)).to.equal(0n);
    });

    it("returns 0 when both are 0", () => {
      expect(estimateToken0Available(0n, 0n)).to.equal(0n);
    });

    it("returns 0 for negative sqrtPriceX96", () => {
      expect(estimateToken0Available(-1n, 1000n)).to.equal(0n);
    });

    it("returns 0 for negative liquidity", () => {
      expect(estimateToken0Available(Q96, -1n)).to.equal(0n);
    });

    it("scales inversely with sqrtPriceX96", () => {
      const liquidity = 10000n * 10n ** 18n;
      const resultA = estimateToken0Available(Q96, liquidity);
      const resultB = estimateToken0Available(Q96 * 2n, liquidity);
      expect(resultB).to.equal(resultA / 2n);
    });

    it("scales linearly with liquidity", () => {
      const sqrtPrice = Q96 * 10n;
      const resultA = estimateToken0Available(sqrtPrice, 100n * 10n ** 18n);
      const resultB = estimateToken0Available(sqrtPrice, 200n * 10n ** 18n);
      expect(resultB).to.equal(resultA * 2n);
    });

    it("produces correct result for pool-like values", () => {
      const liquidity = 360n * 10n ** 18n;
      // sqrtPriceX96 = 10 * Q96 → token0 = L / 10 = 36e18
      const sqrtPriceX96 = Q96 * 10n;
      const result = estimateToken0Available(sqrtPriceX96, liquidity);
      expect(result).to.be.greaterThan(0n);
      expect(result).to.equal(36n * 10n ** 18n);
    });
  });

  describe("sqrtPriceX96ToPriceFloat", () => {
    it("returns 1.0 when sqrtPriceX96 = Q96", () => {
      const price = sqrtPriceX96ToPriceFloat(Q96);
      expect(price).to.be.closeTo(1.0, 1e-10);
    });

    it("returns 4.0 when sqrtPriceX96 = 2*Q96", () => {
      const price = sqrtPriceX96ToPriceFloat(Q96 * 2n);
      expect(price).to.be.closeTo(4.0, 1e-10);
    });
  });

  describe("relativeDiffBps", () => {
    it("returns 0 for equal values", () => {
      expect(relativeDiffBps(100, 100)).to.equal(0);
    });

    it("returns correct bps for known diff", () => {
      // diff=2, mid=101 → 2/101*10000 ≈ 198.02
      const bps = relativeDiffBps(100, 102);
      expect(bps).to.be.closeTo(198.02, 0.1);
    });

    it("returns 0 for non-positive inputs", () => {
      expect(relativeDiffBps(0, 100)).to.equal(0);
      expect(relativeDiffBps(-1, 100)).to.equal(0);
    });
  });

  describe("absBigInt", () => {
    it("returns positive for negative", () => {
      expect(absBigInt(-5n)).to.equal(5n);
    });

    it("returns same for positive", () => {
      expect(absBigInt(5n)).to.equal(5n);
    });

    it("returns 0 for 0", () => {
      expect(absBigInt(0n)).to.equal(0n);
    });
  });

  describe("minBigInt", () => {
    it("returns smaller value", () => {
      expect(minBigInt(3n, 5n)).to.equal(3n);
      expect(minBigInt(5n, 3n)).to.equal(3n);
    });

    it("returns either when equal", () => {
      expect(minBigInt(3n, 3n)).to.equal(3n);
    });
  });

  describe("clamp", () => {
    it("clamps below min", () => {
      expect(clamp(-1, 0, 10)).to.equal(0);
    });

    it("clamps above max", () => {
      expect(clamp(15, 0, 10)).to.equal(10);
    });

    it("returns value when in range", () => {
      expect(clamp(5, 0, 10)).to.equal(5);
    });
  });
});
