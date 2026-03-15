import { expect } from "chai";
import { GasEstimator } from "../../src/execution/GasEstimator";

function makeMockProvider(overrides: {
  gasPrice?: bigint | null;
  estimateGasResult?: bigint;
  estimateGasThrows?: boolean;
} = {}) {
  const gasPrice = overrides.gasPrice === undefined ? 3000000000n : overrides.gasPrice;
  return {
    getFeeData: async () => ({ gasPrice }),
    estimateGas: async () => {
      if (overrides.estimateGasThrows) {
        throw new Error("execution reverted");
      }
      return overrides.estimateGasResult ?? 200000n;
    },
  } as any;
}

describe("GasEstimator", function () {
  describe("estimateGas", function () {
    it("returns gas estimate with buffered limit", async function () {
      const provider = makeMockProvider({ estimateGasResult: 200000n });
      const estimator = new GasEstimator(provider, {
        maxGasPriceGwei: 10,
        gasLimitBuffer: 1.2,
        gasLimitCap: 1_000_000,
      });

      const result = await estimator.estimateGas({ to: "0x01", data: "0x" });
      expect(result).to.not.be.null;
      expect(result!.gasLimit).to.equal(240000n);
      expect(result!.gasPrice).to.equal(3000000000n);
      expect(result!.gasCostWei).to.equal(240000n * 3000000000n);
    });

    it("returns null when gas price exceeds cap", async function () {
      const provider = makeMockProvider({ gasPrice: 15000000000n });
      const estimator = new GasEstimator(provider, { maxGasPriceGwei: 10 });

      const result = await estimator.estimateGas({ to: "0x01", data: "0x" });
      expect(result).to.be.null;
    });

    it("returns null when gas price is unavailable", async function () {
      const provider = makeMockProvider({ gasPrice: null });
      const estimator = new GasEstimator(provider, { maxGasPriceGwei: 10 });

      const result = await estimator.estimateGas({ to: "0x01", data: "0x" });
      expect(result).to.be.null;
    });

    it("returns null when estimateGas reverts", async function () {
      const provider = makeMockProvider({ estimateGasThrows: true });
      const estimator = new GasEstimator(provider, { maxGasPriceGwei: 10 });

      const result = await estimator.estimateGas({ to: "0x01", data: "0x" });
      expect(result).to.be.null;
    });

    it("caps gas limit at gasLimitCap", async function () {
      const provider = makeMockProvider({ estimateGasResult: 900000n });
      const estimator = new GasEstimator(provider, {
        maxGasPriceGwei: 10,
        gasLimitBuffer: 1.5,
        gasLimitCap: 1_000_000,
      });

      const result = await estimator.estimateGas({ to: "0x01", data: "0x" });
      expect(result).to.not.be.null;
      expect(result!.gasLimit).to.equal(1000000n);
    });

    it("applies exact buffer multiplier", async function () {
      const provider = makeMockProvider({ estimateGasResult: 100000n });
      const estimator = new GasEstimator(provider, {
        maxGasPriceGwei: 10,
        gasLimitBuffer: 1.3,
        gasLimitCap: 5_000_000,
      });

      const result = await estimator.estimateGas({ to: "0x01", data: "0x" });
      expect(result!.gasLimit).to.equal(130000n);
    });
  });

  describe("getMaxGasPriceWei", function () {
    it("returns configured max in wei", function () {
      const provider = makeMockProvider();
      const estimator = new GasEstimator(provider, { maxGasPriceGwei: 5 });
      expect(estimator.getMaxGasPriceWei()).to.equal(5000000000n);
    });
  });
});
