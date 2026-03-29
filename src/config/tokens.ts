export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
}

export const TOKENS: Record<string, TokenInfo> = {
  WBNB: {
    symbol: "WBNB",
    address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    decimals: 18,
  },
  USDT: {
    symbol: "USDT",
    address: "0x55d398326f99059fF775485246999027B3197955",
    decimals: 18,
  },
  USDC: {
    symbol: "USDC",
    address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    decimals: 18,
  },
  ETH: {
    symbol: "ETH",
    address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    decimals: 18,
  },
  BTCB: {
    symbol: "BTCB",
    address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
    decimals: 18,
  },
  BUSD: {
    symbol: "BUSD",
    address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    decimals: 18,
  },
};

export const BASE_TOKENS = [TOKENS.WBNB, TOKENS.USDT, TOKENS.USDC, TOKENS.BTCB];

/** Address (lowercased) → decimals */
const DECIMALS_BY_ADDRESS = new Map<string, number>(
  Object.values(TOKENS).map((t) => [t.address.toLowerCase(), t.decimals])
);

/** Set of stablecoin addresses (lowercased) that can be treated as ~$1 */
const STABLECOIN_ADDRESSES = new Set<string>(
  [TOKENS.USDT, TOKENS.USDC, TOKENS.BUSD].map((t) => t.address.toLowerCase())
);

/** Returns the decimals for a known token, or defaults to 18. */
export function getTokenDecimals(address: string): number {
  return DECIMALS_BY_ADDRESS.get(address.toLowerCase()) ?? 18;
}

/** Returns true if the token address is a known USD stablecoin. */
export function isStablecoin(address: string): boolean {
  return STABLECOIN_ADDRESSES.has(address.toLowerCase());
}
