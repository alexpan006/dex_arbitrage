import { Contract, Interface, JsonRpcProvider, WebSocketProvider } from "ethers";
import { BLOCK_TIME_MS, MULTICALL3_ADDRESS, PANCAKESWAP_INFINITY, UNISWAP_V4 } from "../config/constants";
import { Dex, isV4StyleDex } from "../config/pools";
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

const V4_STATE_ABI = [
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) external view returns (uint128)",
];

export interface MonitoredPool extends PoolStaticMeta {}

export interface PriceFeedOptions {
  staleMs?: number;
  fallbackPollBlocks?: number;
}

/** Returns the singleton contract address to read state for a V4-style pool. */
function v4StateTarget(dex: Dex): string {
  if (dex === Dex.UniswapV4) return UNISWAP_V4.stateView;
  if (dex === Dex.PancakeSwapInfinity) return PANCAKESWAP_INFINITY.clPoolManager;
  throw new Error(`v4StateTarget: unsupported dex ${dex}`);
}

export class PriceFeed {
  private readonly wsProvider: WebSocketProvider;
  private readonly fallbackProvider: JsonRpcProvider;
  private readonly multicallWs: Contract;
  private readonly multicallFallback: Contract;
  private readonly poolIface = new Interface(POOL_STATE_ABI);
  private readonly v4Iface = new Interface(V4_STATE_ABI);
  private readonly cache = new PoolStateCache();
  private readonly poolsByAddress = new Map<string, MonitoredPool>();
  private readonly staleMs: number;
  private readonly listeners = new Set<(updated: PoolState[], blockNumber: number) => void>();
  private readonly fallbackPollBlocks: number;

  private running = false;
  private blockHandler: ((blockNumber: number) => Promise<void>) | undefined;
  private blocksSinceLastPoll = 0;
  private lastBlockReceivedAtMs = 0;

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
        this.lastBlockReceivedAtMs = Date.now();
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

  getSecondsSinceLastBlock(): number {
    if (this.lastBlockReceivedAtMs === 0) return 0;
    return (Date.now() - this.lastBlockReceivedAtMs) / 1000;
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

  /**
   * Build a unified multicall batch for both V3 and V4-style pools.
   * V3: target=poolAddress, calls slot0() + liquidity()
   * V4: target=singleton stateView/poolManager, calls getSlot0(poolId) + getLiquidity(poolId)
   * Order matches this.getPools() — 2 calls per pool (slot0/getSlot0 + liquidity/getLiquidity).
   */
  private buildCalls(): Array<{ target: string; allowFailure: boolean; callData: string }> {
    const calls: Array<{ target: string; allowFailure: boolean; callData: string }> = [];

    for (const pool of this.poolsByAddress.values()) {
      if (isV4StyleDex(pool.dex)) {
        // V4/Infinity: target = singleton stateView or poolManager, pass poolId (stored as poolAddress)
        const target = v4StateTarget(pool.dex);
        const poolId = pool.poolAddress; // bytes32 hex PoolId used as synthetic address
        calls.push({
          target,
          allowFailure: true,
          callData: this.v4Iface.encodeFunctionData("getSlot0", [poolId]),
        });
        calls.push({
          target,
          allowFailure: true,
          callData: this.v4Iface.encodeFunctionData("getLiquidity", [poolId]),
        });
      } else {
        // V3: target = per-pool contract address
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
    }

    return calls;
  }

  private static readonly MULTICALL_CHUNK_SIZE = 40; // 20 pools × 2 calls each

  private async tryAggregate(
    multicall: Contract,
    calls: Array<{ target: string; allowFailure: boolean; callData: string }>
  ): Promise<Array<{ success: boolean; returnData: string }> | null> {
    try {
      if (calls.length <= PriceFeed.MULTICALL_CHUNK_SIZE) {
        const res = await multicall.aggregate3.staticCall(calls);
        return res as Array<{ success: boolean; returnData: string }>;
      }

      const chunks: Array<Array<{ target: string; allowFailure: boolean; callData: string }>> = [];
      for (let start = 0; start < calls.length; start += PriceFeed.MULTICALL_CHUNK_SIZE) {
        chunks.push(calls.slice(start, start + PriceFeed.MULTICALL_CHUNK_SIZE));
      }

      const chunkResults = await Promise.all(
        chunks.map((chunk) =>
          multicall.aggregate3.staticCall(chunk).catch(() => null)
        )
      );

      const results: Array<{ success: boolean; returnData: string }> = [];
      for (let i = 0; i < chunkResults.length; i++) {
        if (chunkResults[i]) {
          results.push(...(chunkResults[i] as Array<{ success: boolean; returnData: string }>));
        } else {
          const failedCount = chunks[i].length;
          for (let j = 0; j < failedCount; j++) {
            results.push({ success: false, returnData: "0x" });
          }
        }
      }
      return results;
    } catch (error) {
      logger.warn("multicall failed", { error: String(error) });
      return null;
    }
  }

  /**
   * Decode multicall results. Both V3 and V4 paths produce the same PoolDynamicState.
   * V3 slot0 returns (sqrtPriceX96, tick, ...), V4 getSlot0 returns (sqrtPriceX96, tick, protocolFee, lpFee).
   */
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

      try {
        let sqrtPriceX96: bigint;
        let tick: number;
        let liquidity: bigint;

        if (isV4StyleDex(pool.dex)) {
          const decodedSlot0 = this.v4Iface.decodeFunctionResult("getSlot0", slot0Result.returnData);
          const decodedLiquidity = this.v4Iface.decodeFunctionResult("getLiquidity", liquidityResult.returnData);
          sqrtPriceX96 = BigInt(decodedSlot0.sqrtPriceX96);
          tick = Number(decodedSlot0.tick);
          liquidity = BigInt(decodedLiquidity[0]);
        } else {
          const decodedSlot0 = this.poolIface.decodeFunctionResult("slot0", slot0Result.returnData);
          const decodedLiquidity = this.poolIface.decodeFunctionResult("liquidity", liquidityResult.returnData);
          sqrtPriceX96 = BigInt(decodedSlot0.sqrtPriceX96);
          tick = Number(decodedSlot0.tick);
          liquidity = BigInt(decodedLiquidity[0]);
        }

        const dynamic: PoolDynamicState = {
          sqrtPriceX96,
          tick,
          liquidity,
          blockNumber,
          updatedAtMs: nowMs,
        };

        const next = this.cache.upsert(pool, dynamic);
        updated.push(next);
      } catch (err) {
        logger.warn("failed to decode pool state", {
          pool: pool.poolAddress.slice(0, 18),
          dex: pool.dex,
          error: String(err),
        });
      }
    }

    return updated;
  }
}

/**
 * Build monitored pools from V3-only discovery results (legacy format).
 */
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

/**
 * Build monitored pools from the new multi-DEX discovery format (DiscoveredPairGroup).
 * Works for all 4 DEXes — V4/Infinity pools use PoolId as poolAddress.
 */
export function buildMonitoredPoolsFromGroups(groups: Array<{
  token0: string;
  token1: string;
  pools: Array<{ dex: Dex; poolIdentifier: string; fee: number }>;
}>): MonitoredPool[] {
  const pools: MonitoredPool[] = [];

  for (const group of groups) {
    for (const p of group.pools) {
      pools.push({
        poolAddress: p.poolIdentifier,
        dex: p.dex,
        token0: group.token0,
        token1: group.token1,
        fee: p.fee,
      });
    }
  }

  return pools;
}
