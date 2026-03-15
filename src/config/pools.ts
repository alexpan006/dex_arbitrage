export enum Dex {
  UniswapV3 = "UniswapV3",
  PancakeSwapV3 = "PancakeSwapV3",
}

export interface PoolConfig {
  token0: string;
  token1: string;
  fee: number;
  dex: Dex;
}

export const UNISWAP_V3_FACTORY = "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7";
export const PANCAKESWAP_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";

export const FEE_TIERS = {
  LOWEST: 100,
  LOW: 500,
  MEDIUM_PCS: 2500,
  MEDIUM_UNI: 3000,
  HIGH: 10000,
} as const;

export const INITIAL_PAIRS: Array<{ token0Symbol: string; token1Symbol: string; feeTiers: number[] }> = [
  { token0Symbol: "WBNB", token1Symbol: "USDT", feeTiers: [100, 500, 2500] },
  { token0Symbol: "WBNB", token1Symbol: "USDC", feeTiers: [500, 2500] },
  { token0Symbol: "ETH", token1Symbol: "USDT", feeTiers: [500, 2500] },
  { token0Symbol: "ETH", token1Symbol: "WBNB", feeTiers: [500, 2500] },
];
