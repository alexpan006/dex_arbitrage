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
};

export const BASE_TOKENS = [TOKENS.WBNB, TOKENS.USDT, TOKENS.USDC];
