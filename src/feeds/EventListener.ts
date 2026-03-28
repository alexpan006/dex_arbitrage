import { AbiCoder, Contract, Interface, JsonRpcProvider, Log, WebSocketProvider } from "ethers";
import { MULTICALL3_ADDRESS } from "../config/constants";
import { Dex } from "../config/pools";
import { createLogger } from "../utils/logger";

const logger = createLogger("EventListener");

// ABI signatures recorded alongside topic0 — keccak256 hashes are opaque without source
// Uniswap V3: Swap(address,address,int256,int256,uint160,uint128,int24)
export const UNI_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
// PancakeSwap V3: Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)
export const PCS_SWAP_TOPIC = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
// Mint(address,address,int24,int24,uint128,uint256,uint256)
export const MINT_TOPIC = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
// Burn(address,int24,int24,uint128,uint256,uint256)
export const BURN_TOPIC = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";

const ALL_TOPICS = [UNI_SWAP_TOPIC, PCS_SWAP_TOPIC, MINT_TOPIC, BURN_TOPIC];

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) external payable returns ((bool success, bytes returnData)[] returnData)",
] as const;

const POOL_STATE_ABI_FRAGMENTS = [
  "function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

const poolStateIface = new Interface(POOL_STATE_ABI_FRAGMENTS);
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
  private readonly callbacks: EventListenerCallbacks;
  private readonly dedup: LruDedupCache;
  private readonly backfillEnabled: boolean;

  private running = false;
  private lastProcessedBlock = 0;
  private lastEventAtMs = 0;
  private logHandler: ((log: Log) => void) | null = null;
  private monitoredAddresses: string[] = [];

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
    for (const pool of pools) {
      this.poolsByAddress.set(pool.poolAddress.toLowerCase(), pool);
    }
    this.monitoredAddresses = pools.map((p) => p.poolAddress);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const latest = await this.wsProvider.getBlockNumber();
    this.lastProcessedBlock = latest;

    await this.subscribe();

    logger.info("EventListener started", {
      poolCount: this.poolsByAddress.size,
      startBlock: this.lastProcessedBlock,
      topics: ALL_TOPICS.length,
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
    const filter = {
      address: this.monitoredAddresses,
      topics: [ALL_TOPICS],
    };

    this.logHandler = (log: Log) => {
      try {
        this.handleLog(log);
      } catch (err) {
        logger.warn("error handling log event", { error: String(err) });
      }
    };

    this.wsProvider.on(filter, this.logHandler);

    logger.debug("WSS log subscription active", {
      addresses: this.monitoredAddresses.length,
    });
  }

  private async unsubscribe(): Promise<void> {
    if (this.logHandler) {
      const filter = {
        address: this.monitoredAddresses,
        topics: [ALL_TOPICS],
      };
      this.wsProvider.off(filter, this.logHandler);
      this.logHandler = null;
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

  private handleSwapLog(log: Log, pool: PoolRegistryEntry): void {
    // CRITICAL: PCS data has 7 fields vs UNI's 5, but first 5 are identical layout.
    // AbiCoder.decode ignores trailing bytes, so decoding first 5 works for both.
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
      logger.warn("failed to decode Swap event", {
        pool: pool.poolAddress,
        dex: pool.dex,
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

    try {
      const logs = await this.fallbackProvider.getLogs({
        address: this.monitoredAddresses,
        topics: [ALL_TOPICS],
        fromBlock,
        toBlock,
      });

      let processed = 0;
      for (const log of logs) {
        this.handleLog(log as unknown as Log);
        processed++;
      }

      logger.info("backfill complete", { fromBlock, toBlock, eventsProcessed: processed });
      return processed;
    } catch (err) {
      logger.warn("backfill failed", { fromBlock, toBlock, error: String(err) });
      return 0;
    }
  }

  async fetchPoolState(poolAddress: string): Promise<{
    sqrtPriceX96: bigint;
    tick: number;
    liquidity: bigint;
  } | null> {
    try {
      const multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, this.fallbackProvider);

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
