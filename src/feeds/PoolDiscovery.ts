import { Contract, JsonRpcProvider } from "ethers";
import { DISCOVERY, PANCAKESWAP_V3, UNISWAP_V3 } from "../config/constants";
import { INITIAL_PAIRS } from "../config/pools";
import { TOKENS } from "../config/tokens";
import { createLogger } from "../utils/logger";

const logger = createLogger("PoolDiscovery");

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)",
  "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
] as const;

export interface DiscoveredPoolPair {
  token0: string;
  token1: string;
  fee: number;
  uniswapPool: string;
  pancakePool: string;
}

interface PairKey {
  token0: string;
  token1: string;
  fee: number;
}

function normalizePair(tokenA: string, tokenB: string): { token0: string; token1: string } {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a < b ? { token0: tokenA, token1: tokenB } : { token0: tokenB, token1: tokenA };
}

function keyOf(pair: PairKey): string {
  return `${pair.token0.toLowerCase()}:${pair.token1.toLowerCase()}:${pair.fee}`;
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

function isZeroAddress(value: string): boolean {
  return value.toLowerCase() === "0x0000000000000000000000000000000000000000";
}

export class PoolDiscovery {
  private readonly provider: JsonRpcProvider;
  private readonly uniFactory: Contract;
  private readonly pcsFactory: Contract;

  constructor(provider: JsonRpcProvider) {
    this.provider = provider;
    this.uniFactory = new Contract(UNISWAP_V3.factory, FACTORY_ABI, provider);
    this.pcsFactory = new Contract(PANCAKESWAP_V3.factory, FACTORY_ABI, provider);
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
      const [uniPool, pcsPool] = await Promise.all([
        this.uniFactory.getPool(pair.token0, pair.token1, pair.fee),
        this.pcsFactory.getPool(pair.token0, pair.token1, pair.fee),
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

      if (discovered.length >= DISCOVERY.maxPools) {
        break;
      }
    }

    logger.info("pool discovery complete", { mode, scannedPairs: unique.size, discovered: discovered.length });
    return discovered;
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
