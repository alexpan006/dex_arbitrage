import { expect } from "chai";
import { Dex } from "../../src/config/pools";
import { PoolStateCache, PoolStaticMeta, PoolDynamicState } from "../../src/feeds/PoolStateCache";
import { OpportunityDetector } from "../../src/strategy/OpportunityDetector";
import { RollingDetectorMetrics } from "../../src/monitoring/RollingDetectorMetrics";
import { SubmissionRoute } from "../../src/execution/PrivateTxSubmitter";
import { ExecutionEngine } from "../../src/execution/ExecutionEngine";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const FEE = 500;

const UNI_POOL = "0x0000000000000000000000000000000000000001";
const PCS_POOL = "0x0000000000000000000000000000000000000002";

function makeMeta(dex: Dex, poolAddress: string): PoolStaticMeta {
  return { poolAddress, dex, token0: WBNB, token1: USDT, fee: FEE };
}

function makeDynamic(sqrtPriceX96: bigint, blockNumber = 100): PoolDynamicState {
  return {
    sqrtPriceX96,
    tick: 0,
    liquidity: 10n ** 22n,
    blockNumber,
    updatedAtMs: Date.now(),
  };
}

function makeFakeQuoterService(spreadToken0: bigint) {
  let callCount = 0;
  return {
    quoteExactInputSingle: async (req: { amountIn: bigint }) => {
      callCount += 1;
      if (callCount % 2 === 1) {
        return { amountOut: req.amountIn * 300n };
      }
      return { amountOut: req.amountIn + spreadToken0 };
    },
    batchQuoteExactInputSingle: async (requests: Array<{ amountIn: bigint }>) => {
      return requests.map((req) => {
        callCount += 1;
        if (callCount % 2 === 1) {
          return { amountOut: req.amountIn * 300n };
        }
        return { amountOut: req.amountIn + spreadToken0 };
      });
    },
  } as any;
}

function makeMockGasEstimator() {
  return {
    estimateGas: async () => ({
      gasLimit: 300000n,
      gasPrice: 3000000000n,
      gasCostWei: 300000n * 3000000000n,
    }),
    getMaxGasPriceWei: () => 10000000000n,
  } as any;
}

function makeMockSubmitter() {
  return {
    submit: async () => ({
      txHash: "0xIntegrationTestHash",
      route: SubmissionRoute.BuilderProxy,
    }),
  } as any;
}

function makeMockProvider() {
  return {
    getTransactionCount: async () => 0,
    getTransactionReceipt: async () => ({
      status: 1,
      gasUsed: 200000n,
      blockNumber: 101,
    }),
  } as any;
}

function makeMockWallet() {
  const mockProvider = {
    resolveName: async (name: string) => name,
  };
  return {
    address: "0xIntegrationWallet",
    signTransaction: async () => "0xSignedIntegration",
    provider: mockProvider,
    getAddress: async () => "0xIntegrationWallet",
    resolveName: async (name: string) => name,
    connect: () => {},
  } as any;
}

describe("Full Cycle Integration (no fork)", function () {
  it("PoolStateCache → OpportunityDetector → RollingMetrics → ExecutionEngine dry run", async function () {
    const cache = new PoolStateCache();

    const uniSqrt = 1n << 96n;
    const pcsSqrt = (uniSqrt * 10100n) / 10000n;

    cache.upsert(makeMeta(Dex.UniswapV3, UNI_POOL), makeDynamic(uniSqrt));
    cache.upsert(makeMeta(Dex.PancakeSwapV3, PCS_POOL), makeDynamic(pcsSqrt));

    expect(cache.size()).to.equal(2);
    expect(cache.getByPair(WBNB, USDT)).to.have.length(2);

    const profitPerUnit = 10n ** 16n;
    const quoter = makeFakeQuoterService(profitPerUnit);

    const detector = new OpportunityDetector(quoter, {
      spreadDiffBps: 5,
      maxBorrowToken0: 10n ** 18n,
      minExpectedProfitToken0: 10n ** 15n,
      minBorrowToken0: 10n ** 15n,
      coarseRatiosBps: [5000],
      refineIterations: 0,
      maxQuoteEvaluations: 4,
    });

    const states = cache.getAll();
    const opportunities = await detector.detect(states);

    const metrics = detector.getLastMetrics();
    expect(metrics.pairsScanned).to.be.greaterThanOrEqual(1);
    expect(metrics.durationMs).to.be.greaterThanOrEqual(0);

    const rolling = new RollingDetectorMetrics(60_000);
    rolling.add(metrics);
    const summary = rolling.getSummary();
    expect(summary.sampleCount).to.equal(1);
    expect(summary.avgPairsScanned).to.be.greaterThanOrEqual(1);

    if (opportunities.length === 0) {
      return;
    }

    const top = opportunities[0];
    expect(top.token0.toLowerCase()).to.equal(WBNB.toLowerCase());
    expect(top.token1.toLowerCase()).to.equal(USDT.toLowerCase());
    expect(top.fee).to.equal(FEE);
    expect(top.estimatedBorrowAmountToken0).to.be.greaterThan(0n);

    const engine = new ExecutionEngine(
      makeMockWallet(),
      makeMockProvider(),
      makeMockGasEstimator(),
      makeMockSubmitter(),
      {
        dryRun: true,
        contractAddress: "0xContractAddress",
        txConfirmationTimeoutMs: 2000,
        receiptPollIntervalMs: 50,
      }
    );

    expect(engine.isDryRun()).to.be.true;
    const result = await engine.execute(top);
    expect(result).to.be.null;
    expect(engine.hasPendingTx()).to.be.false;
  });

  it("end-to-end live execution flow with mocked dependencies", async function () {
    const cache = new PoolStateCache();

    const uniSqrt = 1n << 96n;
    const pcsSqrt = (uniSqrt * 10200n) / 10000n;

    cache.upsert(makeMeta(Dex.UniswapV3, UNI_POOL), makeDynamic(uniSqrt));
    cache.upsert(makeMeta(Dex.PancakeSwapV3, PCS_POOL), makeDynamic(pcsSqrt));

    const profitPerUnit = 10n ** 16n;
    const quoter = makeFakeQuoterService(profitPerUnit);

    const detector = new OpportunityDetector(quoter, {
      spreadDiffBps: 5,
      maxBorrowToken0: 10n ** 18n,
      minExpectedProfitToken0: 10n ** 15n,
      minBorrowToken0: 10n ** 15n,
      coarseRatiosBps: [5000],
      refineIterations: 0,
      maxQuoteEvaluations: 4,
    });

    const opportunities = await detector.detect(cache.getAll());

    if (opportunities.length === 0) {
      return;
    }

    const engine = new ExecutionEngine(
      makeMockWallet(),
      makeMockProvider(),
      makeMockGasEstimator(),
      makeMockSubmitter(),
      {
        dryRun: false,
        contractAddress: "0xContractAddress",
        txConfirmationTimeoutMs: 2000,
        receiptPollIntervalMs: 50,
      }
    );

    const result = await engine.execute(opportunities[0]);
    expect(result).to.not.be.null;
    expect(result!.txHash).to.equal("0xIntegrationTestHash");
    expect(result!.confirmed).to.be.true;
    expect(result!.reverted).to.be.false;
    expect(result!.gasUsed).to.equal(200000n);
    expect(engine.hasPendingTx()).to.be.false;
  });

  it("handles empty cache gracefully", async function () {
    const cache = new PoolStateCache();
    const quoter = makeFakeQuoterService(0n);
    const detector = new OpportunityDetector(quoter);

    const opportunities = await detector.detect(cache.getAll());
    expect(opportunities).to.have.length(0);

    const metrics = detector.getLastMetrics();
    expect(metrics.pairsScanned).to.equal(0);
  });

  it("handles single-dex pool pair (no cross-dex opportunities)", async function () {
    const cache = new PoolStateCache();

    cache.upsert(makeMeta(Dex.UniswapV3, UNI_POOL), makeDynamic(1n << 96n));

    const quoter = makeFakeQuoterService(10n ** 16n);
    const detector = new OpportunityDetector(quoter, { spreadDiffBps: 5 });

    const opportunities = await detector.detect(cache.getAll());
    expect(opportunities).to.have.length(0);
  });
});
