import { Contract, JsonRpcProvider } from "ethers";
import { PANCAKESWAP_INFINITY, PANCAKESWAP_V3, UNISWAP_V3, UNISWAP_V4 } from "../config/constants";
import { Dex } from "../config/pools";
import { V4PoolKeyData, V4PoolRegistry } from "../feeds/V4PoolRegistry";

// V3 QuoterV2: (address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)
const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
] as const;

// Uniswap V4 Quoter: PoolKey is 5-slot (currency0, currency1, fee, tickSpacing, hooks)
const V4_QUOTER_ABI = [
  "function quoteExactInputSingle((tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) external returns (uint256 amountOut, uint256 gasEstimate)",
];

// PCS Infinity CLQuoter: PoolKey is 6-slot (currency0, currency1, hooks, poolManager, fee, parameters)
const CL_QUOTER_ABI = [
  "function quoteExactInputSingle((tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) external returns (uint256 amountOut, uint256 gasEstimate)",
];

interface QuoteResult {
  amountOut: bigint;
}

function parseAmountOut(raw: unknown): bigint {
  if (typeof raw === "bigint") {
    return raw;
  }

  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "bigint") {
    return raw[0];
  }

  if (typeof raw === "object" && raw !== null && "amountOut" in raw) {
    const value = (raw as { amountOut: unknown }).amountOut;
    if (typeof value === "bigint") {
      return value;
    }
  }

  throw new Error("UNSUPPORTED_QUOTE_RESULT");
}

export interface QuoteRequest {
  dex: Dex;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: bigint;
  sqrtPriceLimitX96?: bigint;
  poolId?: string;
}

export class QuoterService {
  private readonly uniQuoter: Contract;
  private readonly pcsQuoter: Contract;
  private readonly v4Quoter: Contract;
  private readonly clQuoter: Contract;
  private readonly v4Registry: V4PoolRegistry | null;

  constructor(provider: JsonRpcProvider, v4Registry?: V4PoolRegistry) {
    this.uniQuoter = new Contract(UNISWAP_V3.quoterV2, QUOTER_V2_ABI, provider);
    this.pcsQuoter = new Contract(PANCAKESWAP_V3.quoterV2, QUOTER_V2_ABI, provider);
    this.v4Quoter = new Contract(UNISWAP_V4.quoter, V4_QUOTER_ABI, provider);
    this.clQuoter = new Contract(PANCAKESWAP_INFINITY.clQuoter, CL_QUOTER_ABI, provider);
    this.v4Registry = v4Registry ?? null;
  }

  async quoteExactInputSingle(req: QuoteRequest): Promise<QuoteResult> {
    if (req.dex === Dex.UniswapV4) {
      return this.quoteV4(req);
    }
    if (req.dex === Dex.PancakeSwapInfinity) {
      return this.quotePcsInfinity(req);
    }

    const params = {
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: req.amountIn,
      fee: req.fee,
      sqrtPriceLimitX96: req.sqrtPriceLimitX96 ?? 0n,
    };

    const contract =
      req.dex === Dex.UniswapV3 ? this.uniQuoter : this.pcsQuoter;

    const raw = await contract.quoteExactInputSingle.staticCall(params);
    return { amountOut: parseAmountOut(raw) };
  }

  async batchQuoteExactInputSingle(requests: QuoteRequest[]): Promise<(QuoteResult | null)[]> {
    if (requests.length === 0) {
      return [];
    }

    return Promise.all(
      requests.map(async (req) => {
        try {
          return await this.quoteExactInputSingle(req);
        } catch {
          return null;
        }
      })
    );
  }

  private async quoteV4(req: QuoteRequest): Promise<QuoteResult> {
    const poolKey = this.resolvePoolKey(req);
    if (!poolKey) {
      throw new Error(`V4 PoolKey not found for poolId=${req.poolId}`);
    }

    const zeroForOne = req.tokenIn.toLowerCase() < req.tokenOut.toLowerCase();

    const params = {
      poolKey: {
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
      },
      zeroForOne,
      exactAmount: req.amountIn,
      hookData: "0x",
    };

    const raw = await this.v4Quoter.quoteExactInputSingle.staticCall(params);
    return { amountOut: parseAmountOut(raw) };
  }

  private async quotePcsInfinity(req: QuoteRequest): Promise<QuoteResult> {
    const poolKey = this.resolvePoolKey(req);
    if (!poolKey) {
      throw new Error(`PCS Infinity PoolKey not found for poolId=${req.poolId}`);
    }
    if (!poolKey.poolManager || !poolKey.parameters) {
      throw new Error(`PCS Infinity PoolKey missing poolManager/parameters for poolId=${req.poolId}`);
    }

    const zeroForOne = req.tokenIn.toLowerCase() < req.tokenOut.toLowerCase();

    const params = {
      poolKey: {
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        hooks: poolKey.hooks,
        poolManager: poolKey.poolManager,
        fee: poolKey.fee,
        parameters: poolKey.parameters,
      },
      zeroForOne,
      exactAmount: req.amountIn,
      hookData: "0x",
    };

    const raw = await this.clQuoter.quoteExactInputSingle.staticCall(params);
    return { amountOut: parseAmountOut(raw) };
  }

  private resolvePoolKey(req: QuoteRequest): V4PoolKeyData | undefined {
    if (!this.v4Registry) return undefined;
    if (req.poolId) {
      return this.v4Registry.getKey(req.poolId);
    }
    return undefined;
  }
}
