import { Contract, Interface, JsonRpcProvider } from "ethers";
import { DISCOVERY, MULTICALL3_ADDRESS, PANCAKESWAP_INFINITY, PANCAKESWAP_V3, UNISWAP_V3, UNISWAP_V4 } from "../config/constants";
import { Dex, INITIAL_PAIRS } from "../config/pools";
import { TOKENS } from "../config/tokens";
import { createLogger } from "../utils/logger";
import {
  V4PoolKeyData,
  V4PoolRegistry,
  computePoolId,
  encodePcsInfinityParameters,
} from "./V4PoolRegistry";

const logger = createLogger("PoolDiscovery");

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)",
  "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
] as const;

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) external payable returns ((bool success, bytes returnData)[] returnData)",
] as const;

const V4_STATE_ABI = [
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) external view returns (uint128)",
];

const stateIface = new Interface(V4_STATE_ABI);

const UNI_V4_COMMON_TICK_SPACINGS = [1, 10, 60, 200];
const UNI_V4_COMMON_FEES = [100, 500, 3000, 10000];

const PCS_INF_COMMON_TICK_SPACINGS = [1, 10, 50, 60, 100, 200];
const PCS_INF_COMMON_FEES = [100, 500, 2500, 10000];

export interface DiscoveredPoolPair {
  token0: string;
  token1: string;
  fee: number;
  uniswapPool: string;
  pancakePool: string;
}

export interface DiscoveredPool {
  dex: Dex;
  poolIdentifier: string;
  fee: number;
  tickSpacing?: number;
}

export interface DiscoveredPairGroup {
  token0: string;
  token1: string;
  pools: DiscoveredPool[];
}

interface PairKey {
  token0: string;
  token1: string;
  fee: number;
}

interface V4BruteForceCandidate {
  key: V4PoolKeyData;
  poolId: string;
  stateViewTarget: string;
}

function normalizePair(tokenA: string, tokenB: string): { token0: string; token1: string } {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a < b ? { token0: tokenA, token1: tokenB } : { token0: tokenB, token1: tokenA };
}

function keyOf(pair: PairKey): string {
  return `${pair.token0.toLowerCase()}:${pair.token1.toLowerCase()}:${pair.fee}`;
}

function pairGroupKey(token0: string, token1: string): string {
  const a = token0.toLowerCase();
  const b = token1.toLowerCase();
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function getSeedPairs(): PairKey[] {
  const seeds: PairKey[] = [];

  for (const pair of INITIAL_PAIRS) {
    const token0Info = TOKENS[pair.token0Symbol];
    const token1Info = TOKENS[pair.token1Symbol];
    if (!token0Info || !token1Info) {
      continue;
    }

    const normalized = normalizePair(token0Info.address, token1Info.address);
    for (const fee of pair.feeTiers) {
      seeds.push({ token0: normalized.token0, token1: normalized.token1, fee });
    }
  }

  return seeds;
}

function getTokenPairs(): Array<{ token0: string; token1: string }> {
  const tokenList = Object.values(TOKENS);
  const pairs: Array<{ token0: string; token1: string }> = [];
  for (let i = 0; i < tokenList.length; i++) {
    for (let j = i + 1; j < tokenList.length; j++) {
      const normalized = normalizePair(tokenList[i].address, tokenList[j].address);
      pairs.push(normalized);
    }
  }
  return pairs;
}

function isZeroAddress(value: string): boolean {
  return value.toLowerCase() === "0x0000000000000000000000000000000000000000";
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class PoolDiscovery {
  private readonly provider: JsonRpcProvider;
  private readonly uniFactory: Contract;
  private readonly pcsFactory: Contract;
  private readonly multicall: Contract;

  constructor(provider: JsonRpcProvider) {
    this.provider = provider;
    this.uniFactory = new Contract(UNISWAP_V3.factory, FACTORY_ABI, provider);
    this.pcsFactory = new Contract(PANCAKESWAP_V3.factory, FACTORY_ABI, provider);
    this.multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  }

  async discover(): Promise<DiscoveredPoolPair[]> {
    const mode = DISCOVERY.mode;
    const seeds = mode === "events" ? await this.buildPairsFromEvents() : getSeedPairs();
    const unique = new Map<string, PairKey>();

    for (const seed of seeds) {
      unique.set(keyOf(seed), seed);
    }

    const discovered: DiscoveredPoolPair[] = [];
    for (const pair of unique.values()) {
      try {
        const [uniPool, pcsPool] = await Promise.all([
          this.uniFactory.getPool(pair.token0, pair.token1, pair.fee).catch(() => ZERO_ADDRESS),
          this.pcsFactory.getPool(pair.token0, pair.token1, pair.fee).catch(() => ZERO_ADDRESS),
        ]);

        if (!isZeroAddress(uniPool) && !isZeroAddress(pcsPool)) {
          discovered.push({
            token0: pair.token0,
            token1: pair.token1,
            fee: pair.fee,
            uniswapPool: uniPool,
            pancakePool: pcsPool,
          });
        }
      } catch (err) {
        logger.warn("V3 getPool failed for pair", { token0: pair.token0, token1: pair.token1, fee: pair.fee, error: String(err) });
        continue;
      }

      if (discovered.length >= DISCOVERY.maxPools) {
        break;
      }
    }

    logger.info("V3 pool discovery complete", { mode, scannedPairs: unique.size, discovered: discovered.length });
    return discovered;
  }

  async discoverV4Pools(registry: V4PoolRegistry): Promise<number> {
    const tokenPairs = getTokenPairs();
    let totalFound = 0;

    const uniCandidates = this.buildUniV4Candidates(tokenPairs);
    const pcsCandidates = this.buildPcsInfinityCandidates(tokenPairs);

    const uniFound = await this.probeV4Pools(uniCandidates, registry, UNISWAP_V4.stateView);
    totalFound += uniFound;
    logger.info("Uniswap V4 brute-force complete", { candidates: uniCandidates.length, found: uniFound });

    const pcsFound = await this.probeV4Pools(pcsCandidates, registry, PANCAKESWAP_INFINITY.clPoolManager);
    totalFound += pcsFound;
    logger.info("PCS Infinity brute-force complete", { candidates: pcsCandidates.length, found: pcsFound });

    logger.info("V4 pool discovery complete", { totalFound });
    return totalFound;
  }

  async discoverAll(registry: V4PoolRegistry): Promise<DiscoveredPairGroup[]> {
    const [v3Pairs, _v4Count] = await Promise.all([
      this.discover(),
      this.discoverV4Pools(registry),
    ]);

    const groups = new Map<string, DiscoveredPairGroup>();

    for (const pair of v3Pairs) {
      const gk = pairGroupKey(pair.token0, pair.token1);
      let group = groups.get(gk);
      if (!group) {
        const normalized = normalizePair(pair.token0, pair.token1);
        group = { token0: normalized.token0, token1: normalized.token1, pools: [] };
        groups.set(gk, group);
      }
      group.pools.push({
        dex: Dex.UniswapV3,
        poolIdentifier: pair.uniswapPool,
        fee: pair.fee,
      });
      group.pools.push({
        dex: Dex.PancakeSwapV3,
        poolIdentifier: pair.pancakePool,
        fee: pair.fee,
      });
    }

    for (const { poolId, key } of registry.getAll()) {
      const gk = pairGroupKey(key.currency0, key.currency1);
      let group = groups.get(gk);
      if (!group) {
        const normalized = normalizePair(key.currency0, key.currency1);
        group = { token0: normalized.token0, token1: normalized.token1, pools: [] };
        groups.set(gk, group);
      }
      group.pools.push({
        dex: key.dex,
        poolIdentifier: poolId,
        fee: key.fee,
        tickSpacing: key.tickSpacing,
      });
    }

    const result = [...groups.values()].filter((g) => g.pools.length >= 2);

    logger.info("combined discovery complete", {
      totalPairGroups: result.length,
      totalPools: result.reduce((sum, g) => sum + g.pools.length, 0),
    });

    return result;
  }

  private buildUniV4Candidates(tokenPairs: Array<{ token0: string; token1: string }>): V4BruteForceCandidate[] {
    const candidates: V4BruteForceCandidate[] = [];
    for (const { token0, token1 } of tokenPairs) {
      for (const fee of UNI_V4_COMMON_FEES) {
        for (const tickSpacing of UNI_V4_COMMON_TICK_SPACINGS) {
          const key: V4PoolKeyData = {
            dex: Dex.UniswapV4,
            currency0: token0,
            currency1: token1,
            fee,
            tickSpacing,
            hooks: ZERO_ADDRESS,
          };
          const poolId = computePoolId(key);
          candidates.push({ key, poolId, stateViewTarget: UNISWAP_V4.stateView });
        }
      }
    }
    return candidates;
  }

  private buildPcsInfinityCandidates(tokenPairs: Array<{ token0: string; token1: string }>): V4BruteForceCandidate[] {
    const candidates: V4BruteForceCandidate[] = [];
    for (const { token0, token1 } of tokenPairs) {
      for (const fee of PCS_INF_COMMON_FEES) {
        for (const tickSpacing of PCS_INF_COMMON_TICK_SPACINGS) {
          const parameters = encodePcsInfinityParameters(tickSpacing);
          const key: V4PoolKeyData = {
            dex: Dex.PancakeSwapInfinity,
            currency0: token0,
            currency1: token1,
            fee,
            tickSpacing,
            hooks: ZERO_ADDRESS,
            poolManager: PANCAKESWAP_INFINITY.clPoolManager,
            parameters,
          };
          const poolId = computePoolId(key);
          candidates.push({ key, poolId, stateViewTarget: PANCAKESWAP_INFINITY.clPoolManager });
        }
      }
    }
    return candidates;
  }

  private async probeV4Pools(
    candidates: V4BruteForceCandidate[],
    registry: V4PoolRegistry,
    stateViewAddr: string,
  ): Promise<number> {
    if (candidates.length === 0) return 0;

    const BATCH_SIZE = 200;
    let found = 0;

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const calls = batch.map((c) => ({
        target: stateViewAddr,
        allowFailure: true,
        callData: stateIface.encodeFunctionData("getSlot0", [c.poolId]),
      }));

      let results: Array<{ success: boolean; returnData: string }>;
      try {
        results = await this.multicall.aggregate3.staticCall(calls) as Array<{ success: boolean; returnData: string }>;
      } catch (err) {
        logger.warn("V4 brute-force multicall batch failed", { batchStart: i, error: String(err) });
        continue;
      }

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (!result.success) continue;

        try {
          const decoded = stateIface.decodeFunctionResult("getSlot0", result.returnData);
          const sqrtPriceX96 = BigInt(decoded.sqrtPriceX96);
          if (sqrtPriceX96 === 0n) continue;

          const candidate = batch[j];
          registry.register(candidate.poolId, candidate.key);
          found++;

          logger.debug("V4 pool found", {
            dex: candidate.key.dex,
            poolId: candidate.poolId.slice(0, 18) + "...",
            currency0: candidate.key.currency0.slice(0, 10),
            currency1: candidate.key.currency1.slice(0, 10),
            fee: candidate.key.fee,
            tickSpacing: candidate.key.tickSpacing,
          });
        } catch {
          continue;
        }
      }
    }

    return found;
  }

  private async buildPairsFromEvents(): Promise<PairKey[]> {
    const latest = await this.provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - DISCOVERY.eventsLookbackBlocks);
    const pairs = new Map<string, PairKey>();

    await this.scanFactoryEvents(this.uniFactory, fromBlock, latest, pairs);
    await this.scanFactoryEvents(this.pcsFactory, fromBlock, latest, pairs);

    return [...pairs.values()];
  }

  private async scanFactoryEvents(
    factory: Contract,
    fromBlock: number,
    toBlock: number,
    sink: Map<string, PairKey>
  ): Promise<void> {
    const eventFragment = factory.interface.getEvent("PoolCreated");
    if (!eventFragment) {
      throw new Error("PoolCreated event not found in factory interface");
    }
    const topic = eventFragment.topicHash;
    const chunk = Math.max(100, DISCOVERY.eventsChunkSize);

    for (let start = fromBlock; start <= toBlock; start += chunk) {
      const end = Math.min(toBlock, start + chunk - 1);

      const logs = await this.provider.getLogs({
        address: await factory.getAddress(),
        fromBlock: start,
        toBlock: end,
        topics: [topic],
      });

      for (const log of logs) {
        const parsed = factory.interface.parseLog(log);
        if (!parsed) {
          continue;
        }
        const token0 = String(parsed.args.token0);
        const token1 = String(parsed.args.token1);
        const fee = Number(parsed.args.fee);
        const normalized = normalizePair(token0, token1);
        const pair: PairKey = { token0: normalized.token0, token1: normalized.token1, fee };
        sink.set(keyOf(pair), pair);
      }
    }
  }
}
