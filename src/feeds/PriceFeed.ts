import { Contract, Interface, JsonRpcProvider, WebSocketProvider } from "ethers";
import { BLOCK_TIME_MS, MULTICALL3_ADDRESS } from "../config/constants";
import { Dex } from "../config/pools";
import { createLogger } from "../utils/logger";
import { PoolDynamicState, PoolState, PoolStateCache, PoolStaticMeta } from "./PoolStateCache";

const logger = createLogger("PriceFeed");

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) external payable returns ((bool success, bytes returnData)[] returnData)",
] as const;

const POOL_STATE_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() external view returns (uint128)",
] as const;

export interface MonitoredPool extends PoolStaticMeta {}

export interface PriceFeedOptions {
  staleMs?: number;
  fallbackPollBlocks?: number;
}

export class PriceFeed {
  private readonly wsProvider: WebSocketProvider;
  private readonly fallbackProvider: JsonRpcProvider;
  private readonly multicallWs: Contract;
  private readonly multicallFallback: Contract;
  private readonly poolIface = new Interface(POOL_STATE_ABI);
  private readonly cache = new PoolStateCache();
  private readonly poolsByAddress = new Map<string, MonitoredPool>();
  private readonly staleMs: number;
  private readonly listeners = new Set<(updated: PoolState[], blockNumber: number) => void>();
  private readonly fallbackPollBlocks: number;

  private running = false;
  private blockHandler: ((blockNumber: number) => Promise<void>) | undefined;
  private blocksSinceLastPoll = 0;

  constructor(
    wsProvider: WebSocketProvider,
    fallbackProvider: JsonRpcProvider,
    pools: MonitoredPool[],
    options: PriceFeedOptions = {}
  ) {
    this.wsProvider = wsProvider;
    this.fallbackProvider = fallbackProvider;
    this.multicallWs = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, this.wsProvider);
    this.multicallFallback = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, this.fallbackProvider);
    this.staleMs = options.staleMs ?? BLOCK_TIME_MS * 3;
    this.fallbackPollBlocks = options.fallbackPollBlocks ?? 1;

    for (const pool of pools) {
      this.poolsByAddress.set(pool.poolAddress.toLowerCase(), pool);
    }
  }

  onUpdate(listener: (updated: PoolState[], blockNumber: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCache(): PoolStateCache {
    return this.cache;
  }

  getPools(): MonitoredPool[] {
    return [...this.poolsByAddress.values()];
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.blocksSinceLastPoll = 0;
    this.blockHandler = async (blockNumber: number): Promise<void> => {
      try {
        this.blocksSinceLastPoll++;
        if (this.blocksSinceLastPoll >= this.fallbackPollBlocks) {
          this.blocksSinceLastPoll = 0;
          await this.refresh(blockNumber);
        }
      } catch (error) {
        logger.warn("block handler refresh failed, will retry next block", { blockNumber, error: String(error) });
      }
    };

    this.wsProvider.on("block", this.blockHandler);
    const latest = await this.wsProvider.getBlockNumber();
    await this.refresh(latest);
    logger.info("price feed started", { poolCount: this.poolsByAddress.size, latestBlock: latest, fallbackPollBlocks: this.fallbackPollBlocks });
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    if (this.blockHandler) {
      this.wsProvider.off("block", this.blockHandler);
      this.blockHandler = undefined;
    }

    this.running = false;
    logger.info("price feed stopped");
  }

  async refresh(blockNumber?: number): Promise<PoolState[]> {
    const latestBlock = blockNumber ?? (await this.wsProvider.getBlockNumber());
    const calls = this.buildCalls();

    if (calls.length === 0) {
      return [];
    }

    const wsResult = await this.tryAggregate(this.multicallWs, calls);
    const aggregate = wsResult ?? (await this.tryAggregate(this.multicallFallback, calls));

    if (!aggregate) {
      logger.warn("multicall failed on both providers, returning stale cache");
      return this.cache.getAll();
    }

    const now = Date.now();
    const updated = this.decodeAndCache(aggregate, latestBlock, now);
    this.notify(updated, latestBlock);
    return updated;
  }

  getStalePools(nowMs = Date.now()): PoolState[] {
    const cutoff = nowMs - this.staleMs;
    return this.cache.getAll().filter((state) => state.updatedAtMs < cutoff);
  }

  updateSinglePool(poolAddress: string, dynamic: PoolDynamicState): PoolState | null {
    const meta = this.poolsByAddress.get(poolAddress.toLowerCase());
    if (!meta) {
      logger.warn("updateSinglePool: unknown pool address", { poolAddress });
      return null;
    }

    const updated = this.cache.upsert(meta, dynamic);
    return updated;
  }

  private notify(updated: PoolState[], blockNumber: number): void {
    for (const listener of this.listeners) {
      try {
        listener(updated, blockNumber);
      } catch (error) {
        logger.warn("update listener failed", { error: String(error) });
      }
    }
  }

  private buildCalls(): Array<{ target: string; allowFailure: boolean; callData: string }> {
    const calls: Array<{ target: string; allowFailure: boolean; callData: string }> = [];

    for (const pool of this.poolsByAddress.values()) {
      calls.push({
        target: pool.poolAddress,
        allowFailure: true,
        callData: this.poolIface.encodeFunctionData("slot0", []),
      });
      calls.push({
        target: pool.poolAddress,
        allowFailure: true,
        callData: this.poolIface.encodeFunctionData("liquidity", []),
      });
    }

    return calls;
  }

  private async tryAggregate(
    multicall: Contract,
    calls: Array<{ target: string; allowFailure: boolean; callData: string }>
  ): Promise<Array<{ success: boolean; returnData: string }> | null> {
    try {
      const res = await multicall.aggregate3.staticCall(calls);
      return res as Array<{ success: boolean; returnData: string }>;
    } catch (error) {
      logger.warn("multicall failed", { error: String(error) });
      return null;
    }
  }

  private decodeAndCache(
    aggregate: Array<{ success: boolean; returnData: string }>,
    blockNumber: number,
    nowMs: number
  ): PoolState[] {
    const updated: PoolState[] = [];
    const pools = this.getPools();

    for (let i = 0; i < pools.length; i += 1) {
      const pool = pools[i];
      const slot0Result = aggregate[i * 2];
      const liquidityResult = aggregate[i * 2 + 1];

      if (!slot0Result?.success || !liquidityResult?.success) {
        continue;
      }

      const decodedSlot0 = this.poolIface.decodeFunctionResult("slot0", slot0Result.returnData);
      const decodedLiquidity = this.poolIface.decodeFunctionResult("liquidity", liquidityResult.returnData);

      const dynamic: PoolDynamicState = {
        sqrtPriceX96: BigInt(decodedSlot0.sqrtPriceX96),
        tick: Number(decodedSlot0.tick),
        liquidity: BigInt(decodedLiquidity[0]),
        blockNumber,
        updatedAtMs: nowMs,
      };

      const next = this.cache.upsert(pool, dynamic);
      updated.push(next);
    }

    return updated;
  }
}

export function buildMonitoredPools(poolConfigs: Array<{
  uniswapPool: string;
  pancakePool: string;
  token0: string;
  token1: string;
  fee: number;
}>): MonitoredPool[] {
  const pools: MonitoredPool[] = [];

  for (const config of poolConfigs) {
    pools.push({
      poolAddress: config.uniswapPool,
      dex: Dex.UniswapV3,
      token0: config.token0,
      token1: config.token1,
      fee: config.fee,
    });

    pools.push({
      poolAddress: config.pancakePool,
      dex: Dex.PancakeSwapV3,
      token0: config.token0,
      token1: config.token1,
      fee: config.fee,
    });
  }

  return pools;
}
