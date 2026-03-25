import { Contract, JsonRpcProvider } from "ethers";
import { PANCAKESWAP_V3, UNISWAP_V3 } from "../config/constants";
import { Dex } from "../config/pools";

const QUOTER_V2_ABI_VARIANT_A = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
] as const;

const QUOTER_V2_ABI_VARIANT_B = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
] as const;

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
}

export class QuoterService {
  private readonly uniQuoterA: Contract;
  private readonly uniQuoterB: Contract;
  private readonly pcsQuoterA: Contract;
  private readonly pcsQuoterB: Contract;

  constructor(provider: JsonRpcProvider) {
    this.uniQuoterA = new Contract(UNISWAP_V3.quoterV2, QUOTER_V2_ABI_VARIANT_A, provider);
    this.uniQuoterB = new Contract(UNISWAP_V3.quoterV2, QUOTER_V2_ABI_VARIANT_B, provider);
    this.pcsQuoterA = new Contract(PANCAKESWAP_V3.quoterV2, QUOTER_V2_ABI_VARIANT_A, provider);
    this.pcsQuoterB = new Contract(PANCAKESWAP_V3.quoterV2, QUOTER_V2_ABI_VARIANT_B, provider);
  }

  async quoteExactInputSingle(req: QuoteRequest): Promise<QuoteResult> {
    const paramsA = {
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      fee: req.fee,
      amountIn: req.amountIn,
      sqrtPriceLimitX96: req.sqrtPriceLimitX96 ?? 0n,
    };

    const paramsB = {
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: req.amountIn,
      fee: req.fee,
      sqrtPriceLimitX96: req.sqrtPriceLimitX96 ?? 0n,
    };

    const [contractA, contractB] =
      req.dex === Dex.UniswapV3
        ? [this.uniQuoterA, this.uniQuoterB]
        : [this.pcsQuoterA, this.pcsQuoterB];

    try {
      const raw = await contractA.quoteExactInputSingle.staticCall(paramsA);
      return { amountOut: parseAmountOut(raw) };
    } catch {
      const raw = await contractB.quoteExactInputSingle.staticCall(paramsB);
      return { amountOut: parseAmountOut(raw) };
    }
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
}
