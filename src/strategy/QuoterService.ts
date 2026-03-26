import { Contract, JsonRpcProvider } from "ethers";
import { PANCAKESWAP_V3, UNISWAP_V3 } from "../config/constants";
import { Dex } from "../config/pools";

// Both Uniswap V3 and PancakeSwap V3 QuoterV2 on BSC use the same struct layout:
// (address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)
// Selector: 0xc6a5026a
const QUOTER_V2_ABI = [
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
  private readonly uniQuoter: Contract;
  private readonly pcsQuoter: Contract;

  constructor(provider: JsonRpcProvider) {
    this.uniQuoter = new Contract(UNISWAP_V3.quoterV2, QUOTER_V2_ABI, provider);
    this.pcsQuoter = new Contract(PANCAKESWAP_V3.quoterV2, QUOTER_V2_ABI, provider);
  }

  async quoteExactInputSingle(req: QuoteRequest): Promise<QuoteResult> {
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
}
