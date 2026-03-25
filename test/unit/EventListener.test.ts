import { expect } from "chai";
import { AbiCoder, Log } from "ethers";
import { Dex } from "../../src/config/pools";
import {
  BURN_TOPIC,
  EventListener,
  EventListenerCallbacks,
  LiquidityChangeEventData,
  MINT_TOPIC,
  PCS_SWAP_TOPIC,
  PoolRegistryEntry,
  SwapEventData,
  UNI_SWAP_TOPIC,
} from "../../src/feeds/EventListener";

const abiCoder = AbiCoder.defaultAbiCoder();

const FAKE_POOL_UNI = "0x1111111111111111111111111111111111111111";
const FAKE_POOL_PCS = "0x2222222222222222222222222222222222222222";
const FAKE_TOKEN0 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FAKE_TOKEN1 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FAKE_TX_HASH = "0x" + "ab".repeat(32);

const TEST_POOLS: PoolRegistryEntry[] = [
  { poolAddress: FAKE_POOL_UNI, dex: Dex.UniswapV3, token0: FAKE_TOKEN0, token1: FAKE_TOKEN1, fee: 500 },
  { poolAddress: FAKE_POOL_PCS, dex: Dex.PancakeSwapV3, token0: FAKE_TOKEN0, token1: FAKE_TOKEN1, fee: 500 },
];

function encodeUniSwapData(
  amount0: bigint,
  amount1: bigint,
  sqrtPriceX96: bigint,
  liquidity: bigint,
  tick: number
): string {
  return abiCoder.encode(
    ["int256", "int256", "uint160", "uint128", "int24"],
    [amount0, amount1, sqrtPriceX96, liquidity, tick]
  );
}

function encodePcsSwapData(
  amount0: bigint,
  amount1: bigint,
  sqrtPriceX96: bigint,
  liquidity: bigint,
  tick: number,
  protocolFees0: bigint,
  protocolFees1: bigint
): string {
  return abiCoder.encode(
    ["int256", "int256", "uint160", "uint128", "int24", "uint128", "uint128"],
    [amount0, amount1, sqrtPriceX96, liquidity, tick, protocolFees0, protocolFees1]
  );
}

function makeFakeLog(overrides: Partial<Log> & { address: string; topics: string[]; data: string }): Log {
  return {
    blockNumber: overrides.blockNumber ?? 100,
    blockHash: "0x" + "00".repeat(32),
    transactionIndex: 0,
    removed: false,
    address: overrides.address,
    data: overrides.data,
    topics: overrides.topics,
    transactionHash: overrides.transactionHash ?? FAKE_TX_HASH,
    index: overrides.index ?? 0,
    toJSON: () => ({}),
    provider: null as never,
  } as unknown as Log;
}

function makeNoopCallbacks(): EventListenerCallbacks & {
  swapEvents: SwapEventData[];
  liquidityEvents: LiquidityChangeEventData[];
} {
  const swapEvents: SwapEventData[] = [];
  const liquidityEvents: LiquidityChangeEventData[] = [];
  return {
    swapEvents,
    liquidityEvents,
    onSwap: (event) => swapEvents.push(event),
    onLiquidityChange: (event) => liquidityEvents.push(event),
  };
}

describe("EventListener", function () {
  describe("parseLog — Uniswap V3 Swap", function () {
    it("correctly decodes UNI Swap event data", function () {
      const callbacks = makeNoopCallbacks();
      const listener = new EventListener(
        null as never,
        null as never,
        TEST_POOLS,
        callbacks,
        { backfillEnabled: false }
      );

      const data = encodeUniSwapData(
        -1000000000000000000n,
        500000000000000000n,
        79228162514264337593543950336n,
        1000000000000n,
        100
      );

      const log = makeFakeLog({
        address: FAKE_POOL_UNI,
        topics: [
          UNI_SWAP_TOPIC,
          "0x" + "00".repeat(12) + "cc".repeat(20),
          "0x" + "00".repeat(12) + "dd".repeat(20),
        ],
        data,
        blockNumber: 42,
      });

      const parsed = listener.parseLog(log);
      expect(parsed).to.not.be.null;
      expect(parsed!.type).to.equal("swap");

      const swap = parsed as SwapEventData;
      expect(swap.dex).to.equal(Dex.UniswapV3);
      expect(swap.poolAddress).to.equal(FAKE_POOL_UNI);
      expect(swap.sqrtPriceX96).to.equal(79228162514264337593543950336n);
      expect(swap.liquidity).to.equal(1000000000000n);
      expect(swap.tick).to.equal(100);
      expect(swap.amount0).to.equal(-1000000000000000000n);
      expect(swap.amount1).to.equal(500000000000000000n);
      expect(swap.blockNumber).to.equal(42);
    });
  });

  describe("parseLog — PancakeSwap V3 Swap", function () {
    it("correctly decodes PCS Swap event (7-field data, only first 5 used)", function () {
      const callbacks = makeNoopCallbacks();
      const listener = new EventListener(
        null as never,
        null as never,
        TEST_POOLS,
        callbacks,
        { backfillEnabled: false }
      );

      const data = encodePcsSwapData(
        -2000000000000000000n,
        900000000000000000n,
        56022770974786139918731938227n,
        5000000000000n,
        -200,
        1000n,
        2000n
      );

      const log = makeFakeLog({
        address: FAKE_POOL_PCS,
        topics: [
          PCS_SWAP_TOPIC,
          "0x" + "00".repeat(12) + "cc".repeat(20),
          "0x" + "00".repeat(12) + "dd".repeat(20),
        ],
        data,
        blockNumber: 99,
      });

      const parsed = listener.parseLog(log);
      expect(parsed).to.not.be.null;
      expect(parsed!.type).to.equal("swap");

      const swap = parsed as SwapEventData;
      expect(swap.dex).to.equal(Dex.PancakeSwapV3);
      expect(swap.poolAddress).to.equal(FAKE_POOL_PCS);
      expect(swap.sqrtPriceX96).to.equal(56022770974786139918731938227n);
      expect(swap.liquidity).to.equal(5000000000000n);
      expect(swap.tick).to.equal(-200);
      expect(swap.amount0).to.equal(-2000000000000000000n);
      expect(swap.amount1).to.equal(900000000000000000n);
    });
  });

  describe("parseLog — Mint event", function () {
    it("returns liquidity change event for Mint", function () {
      const callbacks = makeNoopCallbacks();
      const listener = new EventListener(
        null as never,
        null as never,
        TEST_POOLS,
        callbacks,
        { backfillEnabled: false }
      );

      const log = makeFakeLog({
        address: FAKE_POOL_UNI,
        topics: [
          MINT_TOPIC,
          "0x" + "00".repeat(12) + "cc".repeat(20),
          "0x" + "00".repeat(31) + "01",
          "0x" + "00".repeat(31) + "02",
        ],
        data: abiCoder.encode(["address", "uint128", "uint256", "uint256"], [FAKE_TOKEN0, 500n, 100n, 200n]),
        blockNumber: 50,
      });

      const parsed = listener.parseLog(log);
      expect(parsed).to.not.be.null;
      expect(parsed!.type).to.equal("mint");
      expect(parsed!.poolAddress).to.equal(FAKE_POOL_UNI);
      expect(parsed!.dex).to.equal(Dex.UniswapV3);
      expect(parsed!.blockNumber).to.equal(50);
    });
  });

  describe("parseLog — Burn event", function () {
    it("returns liquidity change event for Burn", function () {
      const callbacks = makeNoopCallbacks();
      const listener = new EventListener(
        null as never,
        null as never,
        TEST_POOLS,
        callbacks,
        { backfillEnabled: false }
      );

      const log = makeFakeLog({
        address: FAKE_POOL_PCS,
        topics: [
          BURN_TOPIC,
          "0x" + "00".repeat(12) + "cc".repeat(20),
          "0x" + "00".repeat(31) + "01",
          "0x" + "00".repeat(31) + "02",
        ],
        data: abiCoder.encode(["uint128", "uint256", "uint256"], [500n, 100n, 200n]),
        blockNumber: 60,
      });

      const parsed = listener.parseLog(log);
      expect(parsed).to.not.be.null;
      expect(parsed!.type).to.equal("burn");
      expect(parsed!.poolAddress).to.equal(FAKE_POOL_PCS);
      expect(parsed!.dex).to.equal(Dex.PancakeSwapV3);
    });
  });

  describe("parseLog — unknown pool", function () {
    it("returns null for unregistered pool address", function () {
      const callbacks = makeNoopCallbacks();
      const listener = new EventListener(
        null as never,
        null as never,
        TEST_POOLS,
        callbacks,
        { backfillEnabled: false }
      );

      const data = encodeUniSwapData(100n, 200n, 79228162514264337593543950336n, 1000n, 0);
      const log = makeFakeLog({
        address: "0x9999999999999999999999999999999999999999",
        topics: [UNI_SWAP_TOPIC, "0x" + "00".repeat(32), "0x" + "00".repeat(32)],
        data,
      });

      const parsed = listener.parseLog(log);
      expect(parsed).to.be.null;
    });
  });

  describe("parseLog — unknown topic", function () {
    it("returns null for unrecognized topic0", function () {
      const callbacks = makeNoopCallbacks();
      const listener = new EventListener(
        null as never,
        null as never,
        TEST_POOLS,
        callbacks,
        { backfillEnabled: false }
      );

      const log = makeFakeLog({
        address: FAKE_POOL_UNI,
        topics: ["0x" + "ff".repeat(32)],
        data: "0x",
      });

      const parsed = listener.parseLog(log);
      expect(parsed).to.be.null;
    });
  });

  describe("dedup cache", function () {
    it("getDedupCacheSize starts at 0", function () {
      const callbacks = makeNoopCallbacks();
      const listener = new EventListener(
        null as never,
        null as never,
        TEST_POOLS,
        callbacks,
        { backfillEnabled: false }
      );

      expect(listener.getDedupCacheSize()).to.equal(0);
    });
  });

  describe("topic0 constants", function () {
    it("UNI and PCS Swap topics are different", function () {
      expect(UNI_SWAP_TOPIC).to.not.equal(PCS_SWAP_TOPIC);
    });

    it("all topics are valid 66-char hex strings", function () {
      for (const topic of [UNI_SWAP_TOPIC, PCS_SWAP_TOPIC, MINT_TOPIC, BURN_TOPIC]) {
        expect(topic).to.match(/^0x[0-9a-f]{64}$/);
      }
    });
  });

  describe("parseLog — case-insensitive pool matching", function () {
    it("matches pool address regardless of case", function () {
      const callbacks = makeNoopCallbacks();
      const listener = new EventListener(
        null as never,
        null as never,
        TEST_POOLS,
        callbacks,
        { backfillEnabled: false }
      );

      const data = encodeUniSwapData(100n, 200n, 79228162514264337593543950336n, 1000n, 50);
      const log = makeFakeLog({
        address: FAKE_POOL_UNI.toUpperCase(),
        topics: [UNI_SWAP_TOPIC, "0x" + "00".repeat(32), "0x" + "00".repeat(32)],
        data,
        blockNumber: 10,
      });

      const parsed = listener.parseLog(log);
      expect(parsed).to.not.be.null;
      expect(parsed!.type).to.equal("swap");
    });
  });

  describe("backfill", function () {
    it("returns 0 when backfill is disabled", async function () {
      const callbacks = makeNoopCallbacks();
      const listener = new EventListener(
        null as never,
        null as never,
        TEST_POOLS,
        callbacks,
        { backfillEnabled: false }
      );

      const count = await listener.backfill(1, 100);
      expect(count).to.equal(0);
    });

    it("returns 0 when fromBlock > toBlock", async function () {
      const callbacks = makeNoopCallbacks();
      const listener = new EventListener(
        null as never,
        null as never,
        TEST_POOLS,
        callbacks,
        { backfillEnabled: true }
      );

      const count = await listener.backfill(200, 100);
      expect(count).to.equal(0);
    });
  });
});
