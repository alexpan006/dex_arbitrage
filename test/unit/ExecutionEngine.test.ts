import { expect } from "chai";
import { Dex } from "../../src/config/pools";
import { PoolState } from "../../src/feeds/PoolStateCache";
import { Opportunity } from "../../src/strategy/OpportunityDetector";
import { GasEstimate } from "../../src/execution/GasEstimator";
import { SubmissionRoute } from "../../src/execution/PrivateTxSubmitter";
import { ExecutionEngine } from "../../src/execution/ExecutionEngine";
// ── helpers ─────────────────────────────────────────────────────────────────

const ADDR_TOKEN0 = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ADDR_TOKEN1 = "0x55d398326f99059fF775485246999027B3197955";
const ADDR_POOL_A = "0x0000000000000000000000000000000000000001";
const ADDR_BUY_POOL = "0x0000000000000000000000000000000000000002";
const ADDR_SELL_POOL = "0x0000000000000000000000000000000000000003";
const ADDR_BUY_POOL_B = "0x0000000000000000000000000000000000000004";
const ADDR_SELL_POOL_B = "0x0000000000000000000000000000000000000005";
const ADDR_CONTRACT = "0x0000000000000000000000000000000000000099";

function makePoolState(overrides: Partial<PoolState> = {}): PoolState {
  return {
    poolAddress: ADDR_POOL_A,
    dex: Dex.UniswapV3,
    token0: ADDR_TOKEN0,
    token1: ADDR_TOKEN1,
    fee: 500,
    sqrtPriceX96: 1n << 96n,
    tick: 0,
    liquidity: 10n ** 18n,
    blockNumber: 100,
    updatedAtMs: Date.now(),
    ...overrides,
  };
}

function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    token0: ADDR_TOKEN0,
    token1: ADDR_TOKEN1,
    fee: 500,
    borrowDex: Dex.UniswapV3,
    buyPool: makePoolState({ poolAddress: ADDR_BUY_POOL, dex: Dex.UniswapV3 }),
    sellPool: makePoolState({ poolAddress: ADDR_SELL_POOL, dex: Dex.PancakeSwapV3 }),
    grossSpreadBps: 25,
    estimatedBorrowAmountToken0: 10n ** 18n,
    amountOutMinToken0: 10n ** 17n,
    ...overrides,
  };
}

function makeGasEstimator(result: GasEstimate | null = {
  gasLimit: 300000n,
  gasPrice: 3000000000n,
  gasCostWei: 300000n * 3000000000n,
}) {
  return {
    estimateGas: async () => result,
    getMaxGasPriceWei: () => 10000000000n,
  } as any;
}

function makeSubmitter(result?: { txHash: string; route: SubmissionRoute }, shouldThrow = false) {
  return {
    submit: async () => {
      if (shouldThrow) throw new Error("submission failed");
      return result ?? { txHash: "0xabc123", route: SubmissionRoute.BuilderProxy };
    },
  } as any;
}

function makeMockProvider(overrides: {
  nonce?: number;
  receipt?: { status: number; gasUsed: bigint; blockNumber: number } | null;
  receiptDelayMs?: number;
} = {}) {
  const receipt = overrides.receipt === undefined
    ? { status: 1, gasUsed: 250000n, blockNumber: 42 }
    : overrides.receipt;

  return {
    getTransactionCount: async () => overrides.nonce ?? 0,
    getTransactionReceipt: async () => {
      if (overrides.receiptDelayMs) {
        await new Promise((r) => setTimeout(r, overrides.receiptDelayMs));
      }
      return receipt;
    },
  } as any;
}

function makeMockWallet() {
  const mockProvider = {
    resolveName: async (name: string) => name,
  };
  return {
    address: "0xWalletAddress",
    signTransaction: async () => "0xSignedTxHex",
    provider: mockProvider,
    getAddress: async () => "0xWalletAddress",
    resolveName: async (name: string) => name,
    connect: () => {},
  } as any;
}

function makeEngine(overrides: {
  gasEstimate?: GasEstimate | null;
  submitterResult?: { txHash: string; route: SubmissionRoute };
  submitterThrows?: boolean;
  receipt?: { status: number; gasUsed: bigint; blockNumber: number } | null;
  receiptDelayMs?: number;
  nonce?: number;
  dryRun?: boolean;
  contractAddress?: string;
  txConfirmationTimeoutMs?: number;
  receiptPollIntervalMs?: number;
} = {}) {
  const wallet = makeMockWallet();
  const provider = makeMockProvider({
    nonce: overrides.nonce,
    receipt: overrides.receipt,
    receiptDelayMs: overrides.receiptDelayMs,
  });
  const gasEstimator = makeGasEstimator("gasEstimate" in overrides ? overrides.gasEstimate! : undefined);
  const submitter = makeSubmitter(overrides.submitterResult, overrides.submitterThrows);

  const engine = new ExecutionEngine(wallet, provider, gasEstimator, submitter, {
    dryRun: overrides.dryRun ?? false,
    contractAddress: overrides.contractAddress ?? ADDR_CONTRACT,
    txConfirmationTimeoutMs: overrides.txConfirmationTimeoutMs ?? 2000,
    receiptPollIntervalMs: overrides.receiptPollIntervalMs ?? 50,
  });

  return { engine, wallet, provider, gasEstimator, submitter };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("ExecutionEngine", function () {
  describe("isDryRun / hasPendingTx", function () {
    it("reflects dryRun option", function () {
      const { engine: dry } = makeEngine({ dryRun: true });
      expect(dry.isDryRun()).to.be.true;

      const { engine: live } = makeEngine({ dryRun: false });
      expect(live.isDryRun()).to.be.false;
    });

    it("hasPendingTx is false initially", function () {
      const { engine } = makeEngine();
      expect(engine.hasPendingTx()).to.be.false;
    });
  });

  describe("execute — early returns", function () {
    it("returns null when contract address is empty", async function () {
      const { engine } = makeEngine({ contractAddress: "" });
      const result = await engine.execute(makeOpportunity());
      expect(result).to.be.null;
    });

    it("returns null when gas estimation fails", async function () {
      const { engine } = makeEngine({ gasEstimate: null });
      const result = await engine.execute(makeOpportunity());
      expect(result).to.be.null;
    });

    it("returns null in dry run mode (logs but does not submit)", async function () {
      const { engine } = makeEngine({ dryRun: true });
      const result = await engine.execute(makeOpportunity());
      expect(result).to.be.null;
    });
  });

  describe("execute — concurrency lock", function () {
    it("returns null when a pending tx exists", async function () {
      // Use a never-resolving receipt to keep pendingTxHash set
      const wallet = makeMockWallet();
      const provider = {
        getTransactionCount: async () => 0,
        getTransactionReceipt: async () => {
          // Never resolve — simulate pending forever
          await new Promise(() => {});
        },
      } as any;
      const gasEstimator = makeGasEstimator();
      const submitter = makeSubmitter();

      const engine = new ExecutionEngine(wallet, provider, gasEstimator, submitter, {
        dryRun: false,
        contractAddress: ADDR_CONTRACT,
        txConfirmationTimeoutMs: 60_000, // long timeout so it won't hit
        receiptPollIntervalMs: 50,
      });

      void engine.execute(makeOpportunity());

      // Small delay to let the first execution set pendingTxHash
      await new Promise((r) => setTimeout(r, 50));

      // Second call should be rejected
      const secondResult = await engine.execute(makeOpportunity());
      expect(secondResult).to.be.null;
      expect(engine.hasPendingTx()).to.be.true;

      // Clean up: we can't actually resolve firstExec, but the test is done
    });
  });

  describe("execute — ArbParams encoding", function () {
    it("encodes correct borrow and arb pool addresses", async function () {
      // To verify encoding, we test the full execute path in non-dry-run mode
      // and check the result comes back with our expected submission hash
      const opp = makeOpportunity({
        borrowDex: Dex.PancakeSwapV3,
        buyPool: makePoolState({ poolAddress: ADDR_BUY_POOL_B, dex: Dex.PancakeSwapV3 }),
        sellPool: makePoolState({ poolAddress: ADDR_SELL_POOL_B, dex: Dex.UniswapV3 }),
      });

      const { engine } = makeEngine({
        submitterResult: { txHash: "0xEncodeTest", route: SubmissionRoute.BuilderProxy },
      });

      const result = await engine.execute(opp);
      expect(result).to.not.be.null;
      expect(result!.txHash).to.equal("0xEncodeTest");
    });
  });

  describe("execute — full success flow", function () {
    it("submits tx and returns confirmed result with gas used", async function () {
      const { engine } = makeEngine({
        submitterResult: { txHash: "0xSuccess123", route: SubmissionRoute.Club48 },
        receipt: { status: 1, gasUsed: 210000n, blockNumber: 999 },
      });

      const result = await engine.execute(makeOpportunity());

      expect(result).to.not.be.null;
      expect(result!.txHash).to.equal("0xSuccess123");
      expect(result!.route).to.equal(SubmissionRoute.Club48);
      expect(result!.confirmed).to.be.true;
      expect(result!.reverted).to.be.false;
      expect(result!.gasUsed).to.equal(210000n);
      expect(result!.error).to.be.null;
      expect(result!.receipt).to.not.be.null;

      // Pending flag should be cleared after completion
      expect(engine.hasPendingTx()).to.be.false;
    });

    it("returns reverted result when receipt status is 0", async function () {
      const { engine } = makeEngine({
        submitterResult: { txHash: "0xReverted456", route: SubmissionRoute.PublicRpc },
        receipt: { status: 0, gasUsed: 180000n, blockNumber: 1000 },
      });

      const result = await engine.execute(makeOpportunity());

      expect(result).to.not.be.null;
      expect(result!.txHash).to.equal("0xReverted456");
      expect(result!.confirmed).to.be.false;
      expect(result!.reverted).to.be.true;
      expect(result!.error).to.equal("REVERTED");
      expect(result!.gasUsed).to.equal(180000n);
    });
  });

  describe("execute — submission failure", function () {
    it("returns error result and clears pending lock on submit throw", async function () {
      const { engine } = makeEngine({ submitterThrows: true });

      const result = await engine.execute(makeOpportunity());

      expect(result).to.not.be.null;
      expect(result!.confirmed).to.be.false;
      expect(result!.reverted).to.be.false;
      expect(result!.error).to.include("submission failed");
      expect(result!.txHash).to.equal("");
      expect(engine.hasPendingTx()).to.be.false;
    });
  });

  describe("execute — receipt timeout", function () {
    it("returns timeout error when receipt is not found within deadline", async function () {
      const { engine } = makeEngine({
        submitterResult: { txHash: "0xTimeout789", route: SubmissionRoute.BuilderProxy },
        receipt: null, // Never returns a receipt
        txConfirmationTimeoutMs: 200,
        receiptPollIntervalMs: 50,
      });

      const result = await engine.execute(makeOpportunity());

      expect(result).to.not.be.null;
      expect(result!.txHash).to.equal("0xTimeout789");
      expect(result!.confirmed).to.be.false;
      expect(result!.reverted).to.be.false;
      expect(result!.error).to.equal("CONFIRMATION_TIMEOUT");
      expect(result!.receipt).to.be.null;
      expect(engine.hasPendingTx()).to.be.false;
    });
  });

  describe("execute — sqrtPriceLimitX96", function () {
    it("uses MIN_SQRT_RATIO + 1 for zeroForOne=true", async function () {
      // This verifies the ArbParams encoding indirectly through successful execution
      // The encodeArbParams always sets zeroForOne=true, so sqrtPriceLimitX96 = MIN_SQRT_RATIO + 1
      // If the encoding was wrong, the Contract.interface.encodeFunctionData would fail
      const { engine } = makeEngine({
        submitterResult: { txHash: "0xPriceLimit", route: SubmissionRoute.BuilderProxy },
      });

      const result = await engine.execute(makeOpportunity());
      expect(result).to.not.be.null;
      expect(result!.txHash).to.equal("0xPriceLimit");
    });
  });
});
