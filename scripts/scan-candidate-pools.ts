/**
 * scan-candidate-pools.ts
 *
 * Scans Uniswap V3 and PancakeSwap V3 factory contracts on BSC to find
 * token pairs that exist on BOTH DEXes — potential arbitrage candidates.
 *
 * For each candidate, it checks:
 *   1. Pool existence on both factories
 *   2. Liquidity (slot0 + liquidity)
 *   3. Current price spread between the two pools
 *   4. Fee tier combinations
 *
 * Usage:
 *   npx ts-node scripts/scan-candidate-pools.ts
 *
 * Outputs results to:
 *   - Console (summary table)
 *   - data/pool-scan-results.json (full data)
 */

import { Contract, JsonRpcProvider } from "ethers";
import { writeFileSync, mkdirSync } from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL = process.env.ALCHEMY_HTTP_URL
  || process.env.CHAINSTACK_HTTP_URL
  || "https://bnb-mainnet.g.alchemy.com/v2/17OCGK9ufWUQnXZ7KunC2";

const UNISWAP_V3_FACTORY = "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7";
const PANCAKESWAP_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";

// All fee tiers to check
const FEE_TIERS = [100, 500, 2500, 3000, 10000];

// ─── Token Registry ──────────────────────────────────────────────────────────
// Verified BSC mainnet addresses

interface TokenDef {
  symbol: string;
  address: string;
  decimals: number;
  tier: "blue-chip" | "major-alt" | "bsc-defi" | "stablecoin" | "meme" | "lst" | "mid-cap";
}

const TOKENS: TokenDef[] = [
  // ── Blue chips (Tier 1) ──
  { symbol: "WBNB",  address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18, tier: "blue-chip" },
  { symbol: "USDT",  address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, tier: "blue-chip" },
  { symbol: "USDC",  address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, tier: "blue-chip" },
  { symbol: "BTCB",  address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", decimals: 18, tier: "blue-chip" },
  { symbol: "ETH",   address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", decimals: 18, tier: "blue-chip" },
  { symbol: "BUSD",  address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", decimals: 18, tier: "blue-chip" },

  // ── Major alts (Tier 2) ──
  { symbol: "CAKE",  address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", decimals: 18, tier: "major-alt" },
  { symbol: "XRP",   address: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE", decimals: 18, tier: "major-alt" },
  { symbol: "DOGE",  address: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43", decimals: 8,  tier: "major-alt" },
  { symbol: "ADA",   address: "0x3EE2200Efb3400faBB9AacF31297cBdD1d435D47", decimals: 18, tier: "major-alt" },
  { symbol: "DOT",   address: "0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402", decimals: 18, tier: "major-alt" },
  { symbol: "LINK",  address: "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD", decimals: 18, tier: "major-alt" },
  { symbol: "SOL",   address: "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF", decimals: 18, tier: "major-alt" },
  { symbol: "UNI",   address: "0xBf5140A22578168FD562DCcF235E5D43A02ce9B1", decimals: 18, tier: "major-alt" },
  { symbol: "AAVE",  address: "0xfb6115445Bff7b52FeB98650C87f44907E58f802", decimals: 18, tier: "major-alt" },
  { symbol: "MATIC", address: "0xCC42724C6683B7E57334c4E856f4c9965ED682bD", decimals: 18, tier: "major-alt" },
  { symbol: "AVAX",  address: "0x1CE0c2827e2eF14D5C4f29a091d735A204794041", decimals: 18, tier: "major-alt" },
  { symbol: "LTC",   address: "0x4338665CBB7B2485A8855A139b75D5e34AB0DB94", decimals: 18, tier: "major-alt" },
  { symbol: "FIL",   address: "0x0D8Ce2A99Bb6e3B7Db580eD848240e4a0F9aE153", decimals: 18, tier: "major-alt" },
  { symbol: "ATOM",  address: "0x0Eb3a705fc54725037CC9e008bDede697f62F335", decimals: 18, tier: "major-alt" },

  // ── BSC DeFi natives (Tier 3) ──
  { symbol: "XVS",   address: "0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63", decimals: 18, tier: "bsc-defi" },
  { symbol: "ALPACA", address: "0x8F0528cE5eF7B51152A59745bEfDD91D97091d2F", decimals: 18, tier: "bsc-defi" },
  { symbol: "BSW",   address: "0x965F527D9159dCe6288a2219DB51fc6Eef120dD1", decimals: 18, tier: "bsc-defi" },
  { symbol: "THE",   address: "0xF4C8E32EaDEC4BFe97E0F595AdD0f4450a863a11", decimals: 18, tier: "bsc-defi" },
  { symbol: "RDNT",  address: "0xf7DE7E8A6bd59ED41a4b5fe50278b3B7f31384dF", decimals: 18, tier: "bsc-defi" },
  { symbol: "BAKE",  address: "0xE02dF9e3e622DeBdD69fb838bB799E3F168902c5", decimals: 18, tier: "bsc-defi" },

  // ── Meme tokens ──
  { symbol: "FLOKI", address: "0xfb5B838b6cfEEdC2873aB27866079AC55363D37E", decimals: 9,  tier: "meme" },
  { symbol: "SHIB",  address: "0x2859e4544C4bB03966803b044A93563Bd2D0DD4D", decimals: 18, tier: "meme" },
  { symbol: "PEPE",  address: "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00", decimals: 18, tier: "meme" },
  { symbol: "BABYDOGE", address: "0xc748673057861a797275CD8A068AbB95A902e8de", decimals: 9, tier: "meme" },
  { symbol: "SIREN", address: "0x997A58129890bBdA032231A52eD1ddC845fc18e1", decimals: 18, tier: "meme" },

  // ── Stablecoins ──
  { symbol: "FDUSD", address: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", decimals: 18, tier: "stablecoin" },
  { symbol: "TUSD",  address: "0x40af3827F39D0EAcBF4A168f8D4ee67c121D11c9", decimals: 18, tier: "stablecoin" },
  { symbol: "DAI",   address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", decimals: 18, tier: "stablecoin" },

  // ── Liquid staking ──
  { symbol: "stkBNB",  address: "0xc2E9d07F66A89c44062459A47a0D2Dc038E4fb16", decimals: 18, tier: "lst" },
  { symbol: "BNBx",   address: "0x1bdd3Cf7F79cfB8EdbB955f20ad99211551BA275", decimals: 18, tier: "lst" },
  { symbol: "ankrBNB", address: "0x52F24a5e03aee338Da5fd9Df68D2b6FAe1178827", decimals: 18, tier: "lst" },
  { symbol: "wstETH", address: "0x26c5e01524d2E6280A48F2c50fF6De7e52E9611C", decimals: 18, tier: "lst" },

  // ── Trending / new candidates (from web research) ──
  { symbol: "RIVER",  address: "0xdA7AD9dea9397cffdDAE2F8a052B82f1484252B3", decimals: 18, tier: "major-alt" },
  { symbol: "ANKR",   address: "0xf307910A4c7bbc79691fD374889b36d8531B08e3", decimals: 18, tier: "major-alt" },
  { symbol: "FET",    address: "0x031b41e504677879370e9DBcF937283A8691Fa7f", decimals: 18, tier: "major-alt" },
  { symbol: "STG",    address: "0xB0D502E938ed5f4df2E681fE6E419ff29631d62b", decimals: 18, tier: "major-alt" },
  { symbol: "PENDLE", address: "0xb3Ed0A426155B79B898849803E3B36552f7ED507", decimals: 18, tier: "major-alt" },
  { symbol: "WOO",    address: "0x4691937a7508860F876c9c0a2a617E7d9E945D4B", decimals: 18, tier: "major-alt" },

  // ── CoinGecko-discovered tokens (Round 3 — high volume on both DEXes) ──
  { symbol: "KOGE",   address: "0xe6DF05CE8C8301223373CF5B969AFCb1498c5528", decimals: 18, tier: "mid-cap" },  // $10M+ vol BOTH DEXes
  { symbol: "WMTX",   address: "0xdbB5cf12408A3ac17D668037Ce289F9Ea75439d7", decimals: 18, tier: "mid-cap" },  // World Mobile Token, $10M PCS $8M Uni
  { symbol: "USD1",   address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d", decimals: 18, tier: "stablecoin" }, // WLFI stablecoin, $4M PCS
  { symbol: "BAS",    address: "0x0f0Df6Cb17ee5e883EDdFEf9153fc6036Bdb4e37", decimals: 18, tier: "mid-cap" },  // BNB Attestation Service, $5M PCS
  { symbol: "QUQ",    address: "0x4Fa7c69a7b69F8BC48233024D546bC299d6b03bf", decimals: 18, tier: "mid-cap" },  // $385M Uni (suspicious — 91.67%)
  { symbol: "DUCKY",  address: "0xaDd50D6A3F931e5B4A14D06A4a77FE71171A462f", decimals: 18, tier: "meme" },     // $648K Uni
  { symbol: "ASTER", address: "0x000ae314e2A2172a039B26378814c252734f556a", decimals: 18, tier: "mid-cap" },   // On Uni V3 BSC
];

// ── Base tokens to pair everything against ──
const BASE_SYMBOLS = ["WBNB", "USDT", "USDC", "BTCB", "ETH", "BUSD", "FDUSD"];

// ─── ABIs ────────────────────────────────────────────────────────────────────

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const Q96 = 2n ** 96n;

function sqrtPriceX96ToPriceFloat(sqrtPriceX96: bigint): number {
  const sqrt = Number(sqrtPriceX96) / Number(Q96);
  return sqrt * sqrt;
}

function relativeDiffBps(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  const mid = (a + b) / 2;
  return Math.abs(a - b) / mid * 10_000;
}

function normalizePair(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PoolInfo {
  address: string;
  sqrtPriceX96: bigint;
  price: number;
  liquidity: bigint;
  tick: number;
}

interface CandidateResult {
  token0Symbol: string;
  token1Symbol: string;
  token0Address: string;
  token1Address: string;
  feeTier: number;
  uniPool: PoolInfo | null;
  pcsPool: PoolInfo | null;
  bothExist: boolean;
  spreadBps: number | null;
  uniLiquidityUsd: string;
  pcsLiquidityUsd: string;
  feeFloorBps: number;
  minSpreadBps: number;
  viable: boolean;
  viabilityReason: string;
}

// ─── Main Scanner ────────────────────────────────────────────────────────────

async function getPoolInfo(
  provider: JsonRpcProvider,
  poolAddress: string,
): Promise<PoolInfo | null> {
  try {
    const pool = new Contract(poolAddress, POOL_ABI, provider);
    const [slot0, liquidity] = await Promise.all([
      pool.slot0(),
      pool.liquidity(),
    ]);
    const sqrtPriceX96 = BigInt(slot0[0]);
    if (sqrtPriceX96 === 0n) return null;
    return {
      address: poolAddress,
      sqrtPriceX96,
      price: sqrtPriceX96ToPriceFloat(sqrtPriceX96),
      liquidity: BigInt(liquidity),
      tick: Number(slot0[1]),
    };
  } catch {
    return null;
  }
}

async function scanPair(
  provider: JsonRpcProvider,
  uniFactory: Contract,
  pcsFactory: Contract,
  tokenA: TokenDef,
  tokenB: TokenDef,
  feeTier: number,
): Promise<CandidateResult> {
  const [token0Addr, token1Addr] = normalizePair(tokenA.address, tokenB.address);
  const token0Sym = tokenA.address.toLowerCase() === token0Addr.toLowerCase() ? tokenA.symbol : tokenB.symbol;
  const token1Sym = tokenA.address.toLowerCase() === token0Addr.toLowerCase() ? tokenB.symbol : tokenA.symbol;

  // Query both factories
  let uniPoolAddr: string;
  let pcsPoolAddr: string;
  try {
    [uniPoolAddr, pcsPoolAddr] = await Promise.all([
      uniFactory.getPool(token0Addr, token1Addr, feeTier),
      pcsFactory.getPool(token0Addr, token1Addr, feeTier),
    ]);
  } catch {
    return {
      token0Symbol: token0Sym, token1Symbol: token1Sym,
      token0Address: token0Addr, token1Address: token1Addr,
      feeTier,
      uniPool: null, pcsPool: null,
      bothExist: false, spreadBps: null,
      uniLiquidityUsd: "0", pcsLiquidityUsd: "0",
      feeFloorBps: (feeTier * 2) / 100,
      minSpreadBps: (feeTier * 2) / 100 + 1,
      viable: false, viabilityReason: "factory_query_failed",
    };
  }

  const uniExists = uniPoolAddr !== ZERO_ADDRESS;
  const pcsExists = pcsPoolAddr !== ZERO_ADDRESS;
  const bothExist = uniExists && pcsExists;

  if (!bothExist) {
    return {
      token0Symbol: token0Sym, token1Symbol: token1Sym,
      token0Address: token0Addr, token1Address: token1Addr,
      feeTier,
      uniPool: null, pcsPool: null,
      bothExist: false, spreadBps: null,
      uniLiquidityUsd: "0", pcsLiquidityUsd: "0",
      feeFloorBps: (feeTier * 2) / 100,
      minSpreadBps: (feeTier * 2) / 100 + 1,
      viable: false,
      viabilityReason: uniExists ? "pcs_pool_missing" : pcsExists ? "uni_pool_missing" : "both_missing",
    };
  }

  // Get pool state
  const [uniPool, pcsPool] = await Promise.all([
    getPoolInfo(provider, uniPoolAddr),
    getPoolInfo(provider, pcsPoolAddr),
  ]);

  const feeFloorBps = (feeTier * 2) / 100; // Same fee on both sides
  const minSpreadBps = feeFloorBps + 1; // SPREAD_DIFF_BPS = 1

  if (!uniPool || !pcsPool) {
    return {
      token0Symbol: token0Sym, token1Symbol: token1Sym,
      token0Address: token0Addr, token1Address: token1Addr,
      feeTier,
      uniPool, pcsPool,
      bothExist: true, spreadBps: null,
      uniLiquidityUsd: "0", pcsLiquidityUsd: "0",
      feeFloorBps, minSpreadBps,
      viable: false, viabilityReason: "pool_state_unreadable",
    };
  }

  const spreadBps = relativeDiffBps(uniPool.price, pcsPool.price);

  // Estimate rough USD liquidity (very approximate)
  // For token0/token1 with WBNB or stablecoins, liquidity is a proxy
  const uniLiq = uniPool.liquidity.toString();
  const pcsLiq = pcsPool.liquidity.toString();

  // Viability assessment
  let viable = true;
  let viabilityReason = "candidate";

  if (uniPool.liquidity === 0n || pcsPool.liquidity === 0n) {
    viable = false;
    viabilityReason = "zero_liquidity";
  } else if (uniPool.liquidity < 1000n && pcsPool.liquidity < 1000n) {
    viable = false;
    viabilityReason = "dust_liquidity";
  }

  return {
    token0Symbol: token0Sym, token1Symbol: token1Sym,
    token0Address: token0Addr, token1Address: token1Addr,
    feeTier,
    uniPool, pcsPool,
    bothExist: true,
    spreadBps,
    uniLiquidityUsd: uniLiq,
    pcsLiquidityUsd: pcsLiq,
    feeFloorBps, minSpreadBps,
    viable, viabilityReason,
  };
}

async function main() {
  console.log("🔍 BSC V3 Pool Candidate Scanner");
  console.log("=".repeat(80));
  console.log(`RPC: ${RPC_URL.substring(0, 50)}...`);
  console.log(`Tokens: ${TOKENS.length}`);
  console.log(`Fee tiers: ${FEE_TIERS.join(", ")}`);
  console.log();

  const provider = new JsonRpcProvider(RPC_URL);
  const uniFactory = new Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, provider);
  const pcsFactory = new Contract(PANCAKESWAP_V3_FACTORY, FACTORY_ABI, provider);

  const blockNumber = await provider.getBlockNumber();
  console.log(`Block: ${blockNumber}\n`);

  // Build all unique pairs: every token against each base token
  const baseTokens = TOKENS.filter((t) => BASE_SYMBOLS.includes(t.symbol));
  const nonBaseTokens = TOKENS.filter((t) => !BASE_SYMBOLS.includes(t.symbol));

  // Also include base-vs-base pairs (e.g. WBNB/USDT, USDT/USDC, etc.)
  const pairsToScan: Array<{ tokenA: TokenDef; tokenB: TokenDef; feeTier: number }> = [];
  const seenKeys = new Set<string>();

  function addPair(a: TokenDef, b: TokenDef, fee: number) {
    if (a.symbol === b.symbol) return;
    const [lo, hi] = normalizePair(a.address, b.address);
    const key = `${lo}:${hi}:${fee}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    pairsToScan.push({ tokenA: a, tokenB: b, feeTier: fee });
  }

  // Base vs base
  for (let i = 0; i < baseTokens.length; i++) {
    for (let j = i + 1; j < baseTokens.length; j++) {
      for (const fee of FEE_TIERS) {
        addPair(baseTokens[i], baseTokens[j], fee);
      }
    }
  }

  // Non-base vs base
  for (const token of nonBaseTokens) {
    for (const base of baseTokens) {
      for (const fee of FEE_TIERS) {
        addPair(token, base, fee);
      }
    }
  }

  console.log(`Total pair+fee combinations to scan: ${pairsToScan.length}`);
  console.log();

  // Scan in batches to avoid RPC rate limits
  const BATCH_SIZE = 10;
  const results: CandidateResult[] = [];
  let scanned = 0;

  for (let i = 0; i < pairsToScan.length; i += BATCH_SIZE) {
    const batch = pairsToScan.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((p) => scanPair(provider, uniFactory, pcsFactory, p.tokenA, p.tokenB, p.feeTier)),
    );
    results.push(...batchResults);
    scanned += batch.length;

    if (scanned % 50 === 0 || scanned === pairsToScan.length) {
      const found = results.filter((r) => r.bothExist).length;
      process.stdout.write(`\r  Scanned ${scanned}/${pairsToScan.length} | Found on both: ${found}`);
    }
  }
  console.log("\n");

  // ── Results Analysis ───────────────────────────────────────────────────────

  const bothExist = results.filter((r) => r.bothExist);
  const viable = bothExist.filter((r) => r.viable);
  const withSpread = viable.filter((r) => r.spreadBps !== null && r.spreadBps > 0);

  console.log("=" .repeat(80));
  console.log("SCAN RESULTS");
  console.log("=".repeat(80));
  console.log(`Total scanned:        ${results.length}`);
  console.log(`Pools on BOTH DEXes:  ${bothExist.length}`);
  console.log(`Viable (has liq):     ${viable.length}`);
  console.log(`With non-zero spread: ${withSpread.length}`);
  console.log();

  // Sort by spread descending
  withSpread.sort((a, b) => (b.spreadBps ?? 0) - (a.spreadBps ?? 0));

  // Print top candidates
  console.log("TOP CANDIDATES (sorted by current spread):");
  console.log("-".repeat(120));
  console.log(
    padR("Pair", 22),
    padR("Fee", 7),
    padR("Spread", 12),
    padR("Threshold", 12),
    padR("Above?", 8),
    padR("Uni Liq", 22),
    padR("PCS Liq", 22),
    padR("Status", 15),
  );
  console.log("-".repeat(120));

  for (const r of withSpread.slice(0, 50)) {
    const pair = `${r.token0Symbol}/${r.token1Symbol}`;
    const above = r.spreadBps !== null && r.spreadBps >= r.minSpreadBps;
    console.log(
      padR(pair, 22),
      padR(String(r.feeTier), 7),
      padR(`${r.spreadBps?.toFixed(2)} bps`, 12),
      padR(`${r.minSpreadBps.toFixed(0)} bps`, 12),
      padR(above ? "✅ YES" : "❌ no", 8),
      padR(r.uniLiquidityUsd, 22),
      padR(r.pcsLiquidityUsd, 22),
      padR(r.viabilityReason, 15),
    );
  }

  console.log();

  // Print all pools that exist on both DEXes (for reference)
  console.log("ALL POOLS ON BOTH DEXES:");
  console.log("-".repeat(90));
  for (const r of bothExist) {
    const pair = `${r.token0Symbol}/${r.token1Symbol}`;
    const spreadStr = r.spreadBps !== null ? `${r.spreadBps.toFixed(2)} bps` : "N/A";
    console.log(
      padR(pair, 22),
      padR(`fee=${r.feeTier}`, 12),
      padR(`spread=${spreadStr}`, 20),
      padR(`viable=${r.viable}`, 14),
      padR(r.viabilityReason, 22),
    );
  }
  console.log();

  // ── Categorized Summary ────────────────────────────────────────────────────

  // Group viable pools by pair (ignoring fee tier)
  const pairGroups = new Map<string, CandidateResult[]>();
  for (const r of viable) {
    const key = `${r.token0Symbol}/${r.token1Symbol}`;
    const arr = pairGroups.get(key) ?? [];
    arr.push(r);
    pairGroups.set(key, arr);
  }

  console.log("VIABLE PAIRS (grouped, all fee tiers):");
  console.log("-".repeat(80));
  for (const [pair, pools] of pairGroups) {
    const fees = pools.map((p) => p.feeTier).sort((a, b) => a - b);
    const maxSpread = Math.max(...pools.map((p) => p.spreadBps ?? 0));
    console.log(`  ${padR(pair, 20)} fees: [${fees.join(", ")}]  maxSpread: ${maxSpread.toFixed(2)} bps`);
  }
  console.log();

  // ── Save Results ───────────────────────────────────────────────────────────

  mkdirSync("data", { recursive: true });
  const output = {
    scanTime: new Date().toISOString(),
    blockNumber,
    rpc: RPC_URL.substring(0, 50) + "...",
    totalScanned: results.length,
    totalBothExist: bothExist.length,
    totalViable: viable.length,
    summary: {
      viablePairs: [...pairGroups.entries()].map(([pair, pools]) => ({
        pair,
        feeTiers: pools.map((p) => p.feeTier).sort((a, b) => a - b),
        maxSpread: Math.max(...pools.map((p) => p.spreadBps ?? 0)),
        pools: pools.map((p) => ({
          feeTier: p.feeTier,
          spreadBps: p.spreadBps,
          feeFloorBps: p.feeFloorBps,
          minSpreadBps: p.minSpreadBps,
          uniPoolAddr: p.uniPool?.address,
          pcsPoolAddr: p.pcsPool?.address,
          uniLiquidity: p.uniPool?.liquidity.toString(),
          pcsLiquidity: p.pcsPool?.liquidity.toString(),
          uniTick: p.uniPool?.tick,
          pcsTick: p.pcsPool?.tick,
        })),
      })),
    },
    allBothExist: bothExist.map((r) => ({
      token0: r.token0Symbol,
      token1: r.token1Symbol,
      token0Address: r.token0Address,
      token1Address: r.token1Address,
      feeTier: r.feeTier,
      spreadBps: r.spreadBps,
      viable: r.viable,
      reason: r.viabilityReason,
      uniLiquidity: r.uniPool?.liquidity.toString(),
      pcsLiquidity: r.pcsPool?.liquidity.toString(),
    })),
  };

  writeFileSync("data/pool-scan-results.json", JSON.stringify(output, null, 2));
  console.log("Results saved to data/pool-scan-results.json");

  // ── Recommendations ────────────────────────────────────────────────────────

  console.log();
  console.log("=".repeat(80));
  console.log("RECOMMENDATIONS FOR WHITELIST");
  console.log("=".repeat(80));

  const recommended: string[] = [];
  for (const [pair, pools] of pairGroups) {
    // Recommend pairs with reasonable liquidity on both sides
    const bestPool = pools.reduce((a, b) => {
      const aLiq = BigInt(a.uniLiquidityUsd) + BigInt(a.pcsLiquidityUsd);
      const bLiq = BigInt(b.uniLiquidityUsd) + BigInt(b.pcsLiquidityUsd);
      return bLiq > aLiq ? b : a;
    });
    if (bestPool.uniPool && bestPool.pcsPool) {
      // Both have actual liquidity
      const minLiq = bestPool.uniPool.liquidity < bestPool.pcsPool.liquidity
        ? bestPool.uniPool.liquidity : bestPool.pcsPool.liquidity;
      if (minLiq > 10n ** 10n) { // Some reasonable threshold
        recommended.push(pair);
      }
    }
  }

  if (recommended.length > 0) {
    console.log("Pairs with meaningful liquidity on BOTH DEXes:");
    for (const pair of recommended) {
      const pools = pairGroups.get(pair)!;
      const fees = pools.map((p) => p.feeTier).sort((a, b) => a - b);
      console.log(`  ✅ ${pair}  fees: [${fees.join(", ")}]`);
    }
  } else {
    console.log("⚠️  No pairs met the minimum liquidity threshold.");
    console.log("   This may mean Uniswap V3 on BSC has low adoption for most tokens.");
    console.log("   Consider checking V2 pools or other DEXes.");
  }
}

function padR(s: string, n: number): string {
  return s.padEnd(n);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
