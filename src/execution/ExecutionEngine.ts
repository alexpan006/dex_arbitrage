import {
  Contract,
  JsonRpcProvider,
  Wallet,
  TransactionReceipt,
  TransactionRequest,
} from "ethers";
import { CHAIN_ID, EXECUTION, MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "../config/constants";
import { Dex } from "../config/pools";
import { Opportunity } from "../strategy/OpportunityDetector";
import { GasEstimator, GasEstimate } from "./GasEstimator";
import { PrivateTxSubmitter, SubmissionResult, SubmissionRoute } from "./PrivateTxSubmitter";
import { createLogger } from "../utils/logger";

const logger = createLogger("ExecutionEngine");

// Matches FlashSwapArbitrage.sol DexType enum
// V4/Infinity placeholders — execution not yet supported for V4-style DEXes
const DEX_TYPE: Record<Dex, number> = {
  [Dex.UniswapV3]: 0,
  [Dex.PancakeSwapV3]: 1,
  [Dex.UniswapV4]: 2,
  [Dex.PancakeSwapInfinity]: 3,
};

// Minimal ABI for FlashSwapArbitrage.executeArbitrage(ArbParams)
const EXECUTE_ARB_ABI = [
  "function executeArbitrage(tuple(address poolBorrow, address poolArb, uint8 borrowDex, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, uint256 amountOutMin) params)",
];

export interface ExecutionResult {
  txHash: string;
  route: SubmissionRoute;
  receipt: TransactionReceipt | null;
  confirmed: boolean;
  reverted: boolean;
  gasUsed: bigint | null;
  error: string | null;
}

export interface ExecutionEngineOptions {
  dryRun: boolean;
  contractAddress: string;
  txConfirmationTimeoutMs: number;
  receiptPollIntervalMs: number;
}

const DEFAULT_OPTIONS: ExecutionEngineOptions = {
  dryRun: EXECUTION.dryRun,
  contractAddress: EXECUTION.contractAddress,
  txConfirmationTimeoutMs: EXECUTION.txConfirmationTimeoutMs,
  receiptPollIntervalMs: EXECUTION.receiptPollIntervalMs,
};

export class ExecutionEngine {
  private readonly wallet: Wallet;
  private readonly provider: JsonRpcProvider;
  private readonly gasEstimator: GasEstimator;
  private readonly submitter: PrivateTxSubmitter;
  private readonly contract: Contract;
  private readonly options: ExecutionEngineOptions;
  private pendingTxHash: string | null = null;

  constructor(
    wallet: Wallet,
    provider: JsonRpcProvider,
    gasEstimator: GasEstimator,
    submitter: PrivateTxSubmitter,
    options: Partial<ExecutionEngineOptions> = {}
  ) {
    this.wallet = wallet;
    this.provider = provider;
    this.gasEstimator = gasEstimator;
    this.submitter = submitter;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.contract = new Contract(this.options.contractAddress, EXECUTE_ARB_ABI, wallet);
  }

  isDryRun(): boolean {
    return this.options.dryRun;
  }

  hasPendingTx(): boolean {
    return this.pendingTxHash !== null;
  }

  async execute(opportunity: Opportunity): Promise<ExecutionResult | null> {
    if (this.pendingTxHash) {
      logger.debug("skipping — pending tx exists", { txHash: this.pendingTxHash });
      return null;
    }

    if (!this.options.contractAddress) {
      logger.warn("contract address not configured — cannot execute");
      return null;
    }

    // Encode the ArbParams struct for the contract call
    const arbParams = this.encodeArbParams(opportunity);
    const txData = this.contract.interface.encodeFunctionData("executeArbitrage", [arbParams]);

    const txRequest: TransactionRequest = {
      from: this.wallet.address,
      to: this.options.contractAddress,
      data: txData,
      chainId: CHAIN_ID,
      type: 0, // Legacy TX (BSC does not support EIP-1559)
    };

    // Estimate gas and check price cap
    const gasEstimate = await this.gasEstimator.estimateGas(txRequest);
    if (!gasEstimate) {
      logger.info("gas check failed — skipping opportunity", {
        token0: opportunity.token0,
        token1: opportunity.token1,
        fee: opportunity.fee,
      });
      return null;
    }

    if (this.options.dryRun) {
      logger.info("DRY RUN — would execute", {
        token0: opportunity.token0,
        token1: opportunity.token1,
        fee: opportunity.fee,
        borrowDex: opportunity.borrowDex,
        borrowAmount: opportunity.estimatedBorrowAmountToken0.toString(),
        gasLimit: gasEstimate.gasLimit.toString(),
        gasPriceGwei: Number(gasEstimate.gasPrice) / 1e9,
        gasCostBnb: Number(gasEstimate.gasCostWei) / 1e18,
      });
      return null;
    }

    return this.submitAndMonitor(txRequest, gasEstimate, opportunity);
  }

  private async submitAndMonitor(
    txRequest: TransactionRequest,
    gasEstimate: GasEstimate,
    opportunity: Opportunity
  ): Promise<ExecutionResult> {
    const nonce = await this.provider.getTransactionCount(this.wallet.address, "pending");

    const populatedTx: TransactionRequest = {
      ...txRequest,
      nonce,
      gasLimit: gasEstimate.gasLimit,
      gasPrice: gasEstimate.gasPrice,
    };

    const signedTx = await this.wallet.signTransaction(populatedTx);

    let submission: SubmissionResult;
    try {
      this.pendingTxHash = "pending"; // Lock concurrency before submission
      submission = await this.submitter.submit(signedTx);
      this.pendingTxHash = submission.txHash;
    } catch (error) {
      this.pendingTxHash = null;
      logger.error("tx submission failed", { error: String(error) });
      return {
        txHash: "",
        route: SubmissionRoute.PublicRpc,
        receipt: null,
        confirmed: false,
        reverted: false,
        gasUsed: null,
        error: String(error),
      };
    }

    logger.info("tx submitted — awaiting confirmation", {
      txHash: submission.txHash,
      route: submission.route,
      token0: opportunity.token0,
      token1: opportunity.token1,
      fee: opportunity.fee,
    });

    // Wait for receipt
    const result = await this.waitForReceipt(submission);
    this.pendingTxHash = null;
    return result;
  }

  private async waitForReceipt(submission: SubmissionResult): Promise<ExecutionResult> {
    const deadline = Date.now() + this.options.txConfirmationTimeoutMs;

    while (Date.now() < deadline) {
      try {
        const receipt = await this.provider.getTransactionReceipt(submission.txHash);
        if (receipt) {
          const reverted = receipt.status === 0;
          const gasUsed = receipt.gasUsed;

          if (reverted) {
            logger.warn("tx reverted", {
              txHash: submission.txHash,
              gasUsed: gasUsed.toString(),
            });
          } else {
            logger.info("tx confirmed", {
              txHash: submission.txHash,
              gasUsed: gasUsed.toString(),
              blockNumber: receipt.blockNumber,
            });
          }

          return {
            txHash: submission.txHash,
            route: submission.route,
            receipt,
            confirmed: !reverted,
            reverted,
            gasUsed,
            error: reverted ? "REVERTED" : null,
          };
        }
      } catch (error) {
        logger.debug("receipt poll error", { error: String(error) });
      }

      await sleep(this.options.receiptPollIntervalMs);
    }

    logger.warn("tx confirmation timed out", { txHash: submission.txHash });
    return {
      txHash: submission.txHash,
      route: submission.route,
      receipt: null,
      confirmed: false,
      reverted: false,
      gasUsed: null,
      error: "CONFIRMATION_TIMEOUT",
    };
  }

  private encodeArbParams(opportunity: Opportunity): {
    poolBorrow: string;
    poolArb: string;
    borrowDex: number;
    zeroForOne: boolean;
    amountSpecified: bigint;
    sqrtPriceLimitX96: bigint;
    amountOutMin: bigint;
  } {
    // buyPool = pool where price is higher → we buy token1 here (get more token1 per token0) → this is the borrow pool (flash swap)
    // sellPool = pool where price is lower → we sell token1 here (get more token0 per token1) → this is the arb pool
    const poolBorrow = opportunity.buyPool.poolAddress;
    const poolArb = opportunity.sellPool.poolAddress;
    const borrowDex = DEX_TYPE[opportunity.borrowDex];

    // zeroForOne: borrow token0 to get token1 when buying on the cheap pool
    // The detector already sets borrowDex = buyPool.dex, and borrowAmount is in token0
    // For flash swap: we want to swap token0 → token1 on buyPool (zeroForOne = true)
    const zeroForOne = true;

    // sqrtPriceLimitX96: set to min/max to accept any price (we rely on amountOutMin for slippage)
    const sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

    return {
      poolBorrow,
      poolArb,
      borrowDex,
      zeroForOne,
      amountSpecified: opportunity.estimatedBorrowAmountToken0,
      sqrtPriceLimitX96,
      amountOutMin: opportunity.amountOutMinToken0,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
