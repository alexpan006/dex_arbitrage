import { AbiCoder, Contract, Interface, JsonRpcProvider, Log, WebSocketProvider } from "ethers";
import { MULTICALL3_ADDRESS, PANCAKESWAP_INFINITY, UNISWAP_V4 } from "../config/constants";
import { Dex, isV4StyleDex } from "../config/pools";
import { createLogger } from "../utils/logger";

const logger = createLogger("EventListener");

// V3 Swap topics
// Uniswap V3: Swap(address,address,int256,int256,uint160,uint128,int24)
export const UNI_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
// PancakeSwap V3: Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)
export const PCS_SWAP_TOPIC = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";

// V4/Infinity Swap topics (emitted by singleton PoolManagers, indexed by PoolId in topic[1])
// Uniswap V4: Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
export const UNI_V4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
// PCS Infinity: Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24,uint16)
export const PCS_INF_SWAP_TOPIC = "0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237";

// Mint(address,address,int24,int24,uint128,uint256,uint256)
export const MINT_TOPIC = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
// Burn(address,int24,int24,uint128,uint256,uint256)
export const BURN_TOPIC = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";

const V3_TOPICS = [UNI_SWAP_TOPIC, PCS_SWAP_TOPIC, MINT_TOPIC, BURN_TOPIC];
const V4_SWAP_TOPICS = [UNI_V4_SWAP_TOPIC, PCS_INF_SWAP_TOPIC];

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) external payable returns ((bool success, bytes returnData)[] returnData)",
] as const;

const POOL_STATE_ABI_FRAGMENTS = [
  "function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

const V4_STATE_ABI_FRAGMENTS = [
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) external view returns (uint128)",
];

const poolStateIface = new Interface(POOL_STATE_ABI_FRAGMENTS);
const v4StateIface = new Interface(V4_STATE_ABI_FRAGMENTS);
const abiCoder = AbiCoder.defaultAbiCoder();

export interface SwapEventData {
  type: "swap";
  poolAddress: string;
  dex: Dex;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface LiquidityChangeEventData {
  type: "mint" | "burn";
  poolAddress: string;
  dex: Dex;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export type ParsedEvent = SwapEventData | LiquidityChangeEventData;

export interface PoolRegistryEntry {
  poolAddress: string;
  dex: Dex;
  token0: string;
  token1: string;
  fee: number;
}

class LruDedupCache {
  private readonly maxSize: number;
  private readonly seen = new Map<string, true>();

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  isDuplicate(key: string): boolean {
    if (this.seen.has(key)) {
      return true;
    }
    if (this.seen.size >= this.maxSize) {
      const first = this.seen.keys().next().value;
      if (first !== undefined) {
        this.seen.delete(first);
      }
    }
    this.seen.set(key, true);
    return false;
  }

  clear(): void {
    this.seen.clear();
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface EventListenerCallbacks {
  onSwap: (event: SwapEventData) => void;
  onLiquidityChange: (event: LiquidityChangeEventData) => void;
}

export interface EventListenerOptions {
  dedupCacheSize?: number;
  backfillEnabled?: boolean;
}

export class EventListener {
  private readonly wsProvider: WebSocketProvider;
  private readonly fallbackProvider: JsonRpcProvider;
  private readonly poolsByAddress: Map<string, PoolRegistryEntry>;
  private readonly v4PoolsByPoolId: Map<string, PoolRegistryEntry>;
  private readonly callbacks: EventListenerCallbacks;
  private readonly dedup: LruDedupCache;
  private readonly backfillEnabled: boolean;

  private running = false;
  private lastProcessedBlock = 0;
  private lastEventAtMs = 0;
  private logHandler: ((log: Log) => void) | null = null;
  private v4LogHandler: ((log: Log) => void) | null = null;
  private monitoredAddresses: string[] = [];
  private v4ManagerAddresses: string[] = [];

  constructor(
    wsProvider: WebSocketProvider,
    fallbackProvider: JsonRpcProvider,
    pools: PoolRegistryEntry[],
    callbacks: EventListenerCallbacks,
    options: EventListenerOptions = {}
  ) {
    this.wsProvider = wsProvider;
    this.fallbackProvider = fallbackProvider;
    this.callbacks = callbacks;
    this.dedup = new LruDedupCache(options.dedupCacheSize ?? 5000);
    this.backfillEnabled = options.backfillEnabled ?? true;

    this.poolsByAddress = new Map();
    this.v4PoolsByPoolId = new Map();

    const v3Addresses: string[] = [];
    const v4ManagerSet = new Set<string>();

    for (const pool of pools) {
      if (isV4StyleDex(pool.dex)) {
        this.v4PoolsByPoolId.set(pool.poolAddress.toLowerCase(), pool);
        if (pool.dex === Dex.UniswapV4) {
          v4ManagerSet.add(UNISWAP_V4.poolManager);
        } else if (pool.dex === Dex.PancakeSwapInfinity) {
          v4ManagerSet.add(PANCAKESWAP_INFINITY.clPoolManager);
        }
      } else {
        this.poolsByAddress.set(pool.poolAddress.toLowerCase(), pool);
        v3Addresses.push(pool.poolAddress);
      }
    }

    this.monitoredAddresses = v3Addresses;
    this.v4ManagerAddresses = [...v4ManagerSet];
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const latest = await this.wsProvider.getBlockNumber();
    this.lastProcessedBlock = latest;

    await this.subscribe();

    logger.info("EventListener started", {
      v3PoolCount: this.poolsByAddress.size,
      v4PoolCount: this.v4PoolsByPoolId.size,
      v4Managers: this.v4ManagerAddresses.length,
      startBlock: this.lastProcessedBlock,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    await this.unsubscribe();
    this.dedup.clear();
    logger.info("EventListener stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  getLastProcessedBlock(): number {
    return this.lastProcessedBlock;
  }

  private async subscribe(): Promise<void> {
    if (this.monitoredAddresses.length > 0) {
      const v3Filter = {
        address: this.monitoredAddresses,
        topics: [V3_TOPICS],
      };

      this.logHandler = (log: Log) => {
        try {
          this.handleLog(log);
        } catch (err) {
          logger.warn("error handling V3 log event", { error: String(err) });
        }
      };

      this.wsProvider.on(v3Filter, this.logHandler);
      logger.debug("WSS V3 log subscription active", { addresses: this.monitoredAddresses.length });
    }

    if (this.v4ManagerAddresses.length > 0) {
      const v4Filter = {
        address: this.v4ManagerAddresses,
        topics: [V4_SWAP_TOPICS],
      };

      this.v4LogHandler = (log: Log) => {
        try {
          this.handleV4Log(log);
        } catch (err) {
          logger.warn("error handling V4 log event", { error: String(err) });
        }
      };

      this.wsProvider.on(v4Filter, this.v4LogHandler);
      logger.debug("WSS V4 log subscription active", { managers: this.v4ManagerAddresses.length });
    }
  }

  private async unsubscribe(): Promise<void> {
    if (this.logHandler) {
      const v3Filter = {
        address: this.monitoredAddresses,
        topics: [V3_TOPICS],
      };
      this.wsProvider.off(v3Filter, this.logHandler);
      this.logHandler = null;
    }

    if (this.v4LogHandler) {
      const v4Filter = {
        address: this.v4ManagerAddresses,
        topics: [V4_SWAP_TOPICS],
      };
      this.wsProvider.off(v4Filter, this.v4LogHandler);
      this.v4LogHandler = null;
    }
  }

  private handleLog(log: Log): void {
    this.lastEventAtMs = Date.now();
    const topic0 = log.topics[0];
    if (!topic0) return;

    const dedupKey = `${log.transactionHash}:${log.index}`;
    if (this.dedup.isDuplicate(dedupKey)) {
      logger.debug("duplicate event skipped", { dedupKey });
      return;
    }

    const poolAddr = log.address.toLowerCase();
    const registry = this.poolsByAddress.get(poolAddr);
    if (!registry) return;

    const blockNumber = log.blockNumber;
    if (blockNumber > this.lastProcessedBlock) {
      this.lastProcessedBlock = blockNumber;
    }

    if (topic0 === UNI_SWAP_TOPIC || topic0 === PCS_SWAP_TOPIC) {
      this.handleSwapLog(log, registry);
    } else if (topic0 === MINT_TOPIC || topic0 === BURN_TOPIC) {
      this.handleLiquidityLog(log, registry, topic0);
    }
  }

  private handleV4Log(log: Log): void {
    this.lastEventAtMs = Date.now();
    const topic0 = log.topics[0];
    if (!topic0) return;

    const dedupKey = `${log.transactionHash}:${log.index}`;
    if (this.dedup.isDuplicate(dedupKey)) return;

    // topic[1] is the indexed PoolId (bytes32)
    const poolId = log.topics[1];
    if (!poolId) return;

    const registry = this.v4PoolsByPoolId.get(poolId.toLowerCase());
    if (!registry) return;

    const blockNumber = log.blockNumber;
    if (blockNumber > this.lastProcessedBlock) {
      this.lastProcessedBlock = blockNumber;
    }

    if (topic0 === UNI_V4_SWAP_TOPIC || topic0 === PCS_INF_SWAP_TOPIC) {
      this.handleV4SwapLog(log, registry, topic0);
    }
  }

  private handleSwapLog(log: Log, pool: PoolRegistryEntry): void {
    // V3: data = (int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
    // PCS V3 has 2 extra trailing fields — AbiCoder.decode ignores trailing bytes
    try {
      const decoded = abiCoder.decode(
        ["int256", "int256", "uint160", "uint128", "int24"],
        log.data
      );

      const event: SwapEventData = {
        type: "swap",
        poolAddress: pool.poolAddress,
        dex: pool.dex,
        amount0: BigInt(decoded[0]),
        amount1: BigInt(decoded[1]),
        sqrtPriceX96: BigInt(decoded[2]),
        liquidity: BigInt(decoded[3]),
        tick: Number(decoded[4]),
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.index,
      };

      this.callbacks.onSwap(event);
    } catch (err) {
      logger.warn("failed to decode V3 Swap event", {
        pool: pool.poolAddress,
        dex: pool.dex,
        error: String(err),
      });
    }
  }

  private handleV4SwapLog(log: Log, pool: PoolRegistryEntry, topic0: string): void {
    // V4 Swap data: (int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
    // PCS Infinity adds trailing uint16 protocolFee — AbiCoder.decode ignores trailing bytes
    try {
      const decoded = abiCoder.decode(
        ["int128", "int128", "uint160", "uint128", "int24"],
        log.data
      );

      const event: SwapEventData = {
        type: "swap",
        poolAddress: pool.poolAddress,
        dex: pool.dex,
        amount0: BigInt(decoded[0]),
        amount1: BigInt(decoded[1]),
        sqrtPriceX96: BigInt(decoded[2]),
        liquidity: BigInt(decoded[3]),
        tick: Number(decoded[4]),
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.index,
      };

      this.callbacks.onSwap(event);
    } catch (err) {
      logger.warn("failed to decode V4 Swap event", {
        pool: pool.poolAddress,
        dex: pool.dex,
        topic0: topic0.slice(0, 10),
        error: String(err),
      });
    }
  }

  private handleLiquidityLog(log: Log, pool: PoolRegistryEntry, topic0: string): void {
    const event: LiquidityChangeEventData = {
      type: topic0 === MINT_TOPIC ? "mint" : "burn",
      poolAddress: pool.poolAddress,
      dex: pool.dex,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    };

    this.callbacks.onLiquidityChange(event);
  }

  async backfill(fromBlock: number, toBlock: number): Promise<number> {
    if (!this.backfillEnabled) return 0;
    if (fromBlock > toBlock) return 0;

    logger.info("backfilling missed events", { fromBlock, toBlock, blockGap: toBlock - fromBlock });

    let processed = 0;

    // Backfill V3 events
    if (this.monitoredAddresses.length > 0) {
      try {
        const logs = await this.fallbackProvider.getLogs({
          address: this.monitoredAddresses,
          topics: [V3_TOPICS],
          fromBlock,
          toBlock,
        });

        for (const log of logs) {
          this.handleLog(log as unknown as Log);
          processed++;
        }
      } catch (err) {
        logger.warn("V3 backfill failed", { fromBlock, toBlock, error: String(err) });
      }
    }

    // Backfill V4 events
    if (this.v4ManagerAddresses.length > 0) {
      try {
        const logs = await this.fallbackProvider.getLogs({
          address: this.v4ManagerAddresses,
          topics: [V4_SWAP_TOPICS],
          fromBlock,
          toBlock,
        });

        for (const log of logs) {
          this.handleV4Log(log as unknown as Log);
          processed++;
        }
      } catch (err) {
        logger.warn("V4 backfill failed", { fromBlock, toBlock, error: String(err) });
      }
    }

    logger.info("backfill complete", { fromBlock, toBlock, eventsProcessed: processed });
    return processed;
  }

  async fetchPoolState(poolAddress: string, dex?: Dex): Promise<{
    sqrtPriceX96: bigint;
    tick: number;
    liquidity: bigint;
  } | null> {
    const resolvedDex = dex ?? this.resolveDex(poolAddress);
    if (!resolvedDex) {
      logger.warn("fetchPoolState: unknown pool", { poolAddress });
      return null;
    }

    try {
      const multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, this.fallbackProvider);

      if (isV4StyleDex(resolvedDex)) {
        const target = resolvedDex === Dex.UniswapV4
          ? UNISWAP_V4.stateView
          : PANCAKESWAP_INFINITY.clPoolManager;

        const calls = [
          {
            target,
            allowFailure: true,
            callData: v4StateIface.encodeFunctionData("getSlot0", [poolAddress]),
          },
          {
            target,
            allowFailure: true,
            callData: v4StateIface.encodeFunctionData("getLiquidity", [poolAddress]),
          },
        ];

        const results = await multicall.aggregate3.staticCall(calls) as Array<{ success: boolean; returnData: string }>;
        if (!results[0]?.success || !results[1]?.success) {
          logger.warn("fetchPoolState V4 multicall partial failure", { poolAddress });
          return null;
        }

        const slot0 = v4StateIface.decodeFunctionResult("getSlot0", results[0].returnData);
        const liq = v4StateIface.decodeFunctionResult("getLiquidity", results[1].returnData);

        return {
          sqrtPriceX96: BigInt(slot0.sqrtPriceX96),
          tick: Number(slot0.tick),
          liquidity: BigInt(liq[0]),
        };
      }

      // V3 path
      const calls = [
        {
          target: poolAddress,
          allowFailure: true,
          callData: poolStateIface.encodeFunctionData("slot0", []),
        },
        {
          target: poolAddress,
          allowFailure: true,
          callData: poolStateIface.encodeFunctionData("liquidity", []),
        },
      ];

      const results = await multicall.aggregate3.staticCall(calls) as Array<{ success: boolean; returnData: string }>;
      const slot0Result = results[0];
      const liqResult = results[1];

      if (!slot0Result?.success || !liqResult?.success) {
        logger.warn("fetchPoolState multicall partial failure", { poolAddress });
        return null;
      }

      const slot0 = poolStateIface.decodeFunctionResult("slot0", slot0Result.returnData);
      const liq = poolStateIface.decodeFunctionResult("liquidity", liqResult.returnData);

      return {
        sqrtPriceX96: BigInt(slot0.sqrtPriceX96),
        tick: Number(slot0.tick),
        liquidity: BigInt(liq[0]),
      };
    } catch (err) {
      logger.warn("fetchPoolState failed", { poolAddress, error: String(err) });
      return null;
    }
  }

  private resolveDex(poolAddress: string): Dex | null {
    const addr = poolAddress.toLowerCase();
    const v3 = this.poolsByAddress.get(addr);
    if (v3) return v3.dex;
    const v4 = this.v4PoolsByPoolId.get(addr);
    if (v4) return v4.dex;
    return null;
  }

  getDedupCacheSize(): number {
    return this.dedup.size;
  }

  getSecondsSinceLastEvent(): number {
    if (this.lastEventAtMs === 0) return 0;
    return (Date.now() - this.lastEventAtMs) / 1000;
  }

  parseLog(log: Log): ParsedEvent | null {
    const topic0 = log.topics[0];
    if (!topic0) return null;

    // V4 swap events: check topic[1] as PoolId
    if (topic0 === UNI_V4_SWAP_TOPIC || topic0 === PCS_INF_SWAP_TOPIC) {
      const poolId = log.topics[1];
      if (!poolId) return null;
      const registry = this.v4PoolsByPoolId.get(poolId.toLowerCase());
      if (!registry) return null;

      try {
        const decoded = abiCoder.decode(
          ["int128", "int128", "uint160", "uint128", "int24"],
          log.data
        );
        return {
          type: "swap",
          poolAddress: registry.poolAddress,
          dex: registry.dex,
          amount0: BigInt(decoded[0]),
          amount1: BigInt(decoded[1]),
          sqrtPriceX96: BigInt(decoded[2]),
          liquidity: BigInt(decoded[3]),
          tick: Number(decoded[4]),
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          logIndex: log.index,
        };
      } catch {
        return null;
      }
    }

    // V3 swap events
    const poolAddr = log.address.toLowerCase();
    const registry = this.poolsByAddress.get(poolAddr);
    if (!registry) return null;

    if (topic0 === UNI_SWAP_TOPIC || topic0 === PCS_SWAP_TOPIC) {
      try {
        const decoded = abiCoder.decode(
          ["int256", "int256", "uint160", "uint128", "int24"],
          log.data
        );
        return {
          type: "swap",
          poolAddress: registry.poolAddress,
          dex: registry.dex,
          amount0: BigInt(decoded[0]),
          amount1: BigInt(decoded[1]),
          sqrtPriceX96: BigInt(decoded[2]),
          liquidity: BigInt(decoded[3]),
          tick: Number(decoded[4]),
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          logIndex: log.index,
        };
      } catch {
        return null;
      }
    }

    if (topic0 === MINT_TOPIC || topic0 === BURN_TOPIC) {
      return {
        type: topic0 === MINT_TOPIC ? "mint" : "burn",
        poolAddress: registry.poolAddress,
        dex: registry.dex,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.index,
      };
    }

    return null;
  }
}
