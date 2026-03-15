import { JsonRpcProvider, parseUnits, TransactionRequest } from "ethers";
import { STRATEGY } from "../config/constants";
import { createLogger } from "../utils/logger";

const logger = createLogger("GasEstimator");

export interface GasEstimate {
  gasLimit: bigint;
  gasPrice: bigint;
  gasCostWei: bigint;
}

export interface GasEstimatorOptions {
  maxGasPriceGwei: number;
  gasLimitBuffer: number;
  gasLimitCap: number;
}

const DEFAULT_OPTIONS: GasEstimatorOptions = {
  maxGasPriceGwei: STRATEGY.maxGasPriceGwei,
  gasLimitBuffer: 1.2,
  gasLimitCap: 1_000_000,
};

export class GasEstimator {
  private readonly provider: JsonRpcProvider;
  private readonly options: GasEstimatorOptions;
  private readonly maxGasPriceWei: bigint;

  constructor(provider: JsonRpcProvider, options: Partial<GasEstimatorOptions> = {}) {
    this.provider = provider;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.maxGasPriceWei = parseUnits(this.options.maxGasPriceGwei.toString(), "gwei");
  }

  async estimateGas(tx: TransactionRequest): Promise<GasEstimate | null> {
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice;

    if (gasPrice === null) {
      logger.warn("gas price unavailable from provider");
      return null;
    }

    if (gasPrice > this.maxGasPriceWei) {
      logger.info("gas price exceeds cap", {
        currentGwei: Number(gasPrice) / 1e9,
        maxGwei: this.options.maxGasPriceGwei,
      });
      return null;
    }

    let rawEstimate: bigint;
    try {
      rawEstimate = await this.provider.estimateGas(tx);
    } catch (error) {
      logger.warn("gas estimation failed — tx would likely revert", {
        error: String(error),
      });
      return null;
    }

    const buffered = BigInt(Math.ceil(Number(rawEstimate) * this.options.gasLimitBuffer));
    const gasLimit = buffered > BigInt(this.options.gasLimitCap)
      ? BigInt(this.options.gasLimitCap)
      : buffered;

    const gasCostWei = gasLimit * gasPrice;

    logger.debug("gas estimate", {
      rawEstimate: rawEstimate.toString(),
      buffered: gasLimit.toString(),
      gasPriceGwei: Number(gasPrice) / 1e9,
      gasCostBnb: Number(gasCostWei) / 1e18,
    });

    return { gasLimit, gasPrice, gasCostWei };
  }

  getMaxGasPriceWei(): bigint {
    return this.maxGasPriceWei;
  }
}
