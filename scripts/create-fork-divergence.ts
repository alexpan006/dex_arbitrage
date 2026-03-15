import { JsonRpcProvider, Interface, zeroPadValue, toBeHex } from "ethers";
import { createLogger } from "../src/utils/logger";

const logger = createLogger("fork-divergence");

const POOL_SLOT0_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const poolIface = new Interface(POOL_SLOT0_ABI);

export interface DivergenceResult {
  poolAddress: string;
  originalSqrtPriceX96: bigint;
  newSqrtPriceX96: bigint;
  priceMovePercent: number;
}

async function readSlot0(provider: JsonRpcProvider, poolAddress: string) {
  const calldata = poolIface.encodeFunctionData("slot0");
  const result = await provider.call({ to: poolAddress, data: calldata });
  const decoded = poolIface.decodeFunctionResult("slot0", result);
  return {
    sqrtPriceX96: BigInt(decoded.sqrtPriceX96),
    tick: Number(decoded.tick),
    rawReturnData: result,
  };
}

/**
 * Compute the Uniswap V3 tick from sqrtPriceX96.
 *
 * tick = floor(log(sqrtPriceX96 / 2^96)^2 / log(1.0001))
 *      = floor(2 * log(sqrtPriceX96 / 2^96) / log(1.0001))
 *
 * This uses JS floating point — good enough for our fork testing purpose.
 * The tick must be consistent with the sqrtPriceX96 or QuoterV2 will revert.
 */
function sqrtPriceX96ToTick(sqrtPriceX96: bigint): number {
  // log(sqrtPriceX96 / 2^96) = log(sqrtPriceX96) - 96 * log(2)
  const logSqrtPrice = Math.log(Number(sqrtPriceX96)) - 96 * Math.log(2);
  // tick = floor(2 * logSqrtPrice / log(1.0001))
  const tick = Math.floor(2 * logSqrtPrice / Math.log(1.0001));
  return tick;
}

/**
 * Encode a signed int24 as a 24-bit two's complement value.
 */
function encodeInt24(value: number): bigint {
  if (value >= 0) {
    return BigInt(value) & 0xFFFFFFn;
  }
  // Two's complement for negative: 2^24 + value
  return (0x1000000n + BigInt(value)) & 0xFFFFFFn;
}

/**
 * Repack slot0 with a new sqrtPriceX96 AND tick while preserving all other fields.
 *
 * Uniswap V3 slot0 storage layout (single 256-bit word at storage slot 0):
 *   bits [0..159]   = sqrtPriceX96 (uint160)
 *   bits [160..183] = tick (int24)
 *   bits [184..199] = observationIndex (uint16)
 *   bits [200..215] = observationCardinality (uint16)
 *   bits [216..231] = observationCardinalityNext (uint16)
 *   bits [232..239] = feeProtocol (uint8)
 *   bit  [240]      = unlocked (bool)
 *
 * PancakeSwap V3 slot0 has the same layout for these fields at the same
 * storage slot (verified empirically on BSC fork).
 */
function repackSlot0(rawStorageWord: bigint, newSqrtPriceX96: bigint, newTick: number): bigint {
  const mask160 = (1n << 160n) - 1n;          // bits 0-159
  const mask24At160 = 0xFFFFFFn << 160n;       // bits 160-183
  // Clear sqrtPriceX96 and tick fields, keep everything else
  const preserved = rawStorageWord & ~mask160 & ~mask24At160;
  const tickBits = encodeInt24(newTick) << 160n;
  return preserved | tickBits | (newSqrtPriceX96 & mask160);
}

/**
 * Find the storage slot index where slot0 data lives by scanning slots 0-10
 * and checking if the sqrtPriceX96 from the ABI call matches the low 160 bits.
 */
async function findSlot0StorageIndex(
  provider: JsonRpcProvider,
  poolAddress: string,
  knownSqrtPriceX96: bigint
): Promise<number> {
  const mask160 = (1n << 160n) - 1n;
  for (let slot = 0; slot <= 10; slot++) {
    const raw = await provider.getStorage(poolAddress, slot);
    const word = BigInt(raw);
    if ((word & mask160) === knownSqrtPriceX96) {
      return slot;
    }
  }
  throw new Error(`Could not find slot0 storage index for pool ${poolAddress}`);
}

/**
 * Create price divergence by directly manipulating a pool's slot0 storage.
 *
 * Shifts sqrtPriceX96 by `priceDeltaBps` basis points. The tick field is NOT
 * changed — this is intentional. For small price moves (< ~50 bps), the
 * tick stays within the same initialized tick range, so the tick bitmap
 * remains consistent and QuoterV2 staticCalls succeed.
 *
 * @param priceDeltaBps - How many bps to shift the price (positive = increase sqrtPrice)
 */
export async function createDivergence(
  provider: JsonRpcProvider,
  poolAddress: string,
  _token0: string,
  _token1: string,
  _fee: number,
  _swapAmount: bigint,
  priceDeltaBps = 30
): Promise<DivergenceResult> {
  const slot0Before = await readSlot0(provider, poolAddress);
  logger.info("pool state before manipulation", {
    poolAddress,
    sqrtPriceX96: slot0Before.sqrtPriceX96.toString(),
    tick: slot0Before.tick,
  });

  const storageSlotIndex = await findSlot0StorageIndex(
    provider,
    poolAddress,
    slot0Before.sqrtPriceX96
  );
  logger.info("slot0 storage index found", { storageSlotIndex });

  const rawWord = BigInt(await provider.getStorage(poolAddress, storageSlotIndex));

  const sqrtShiftBps = BigInt(priceDeltaBps);
  const newSqrtPriceX96 =
    slot0Before.sqrtPriceX96 + (slot0Before.sqrtPriceX96 * sqrtShiftBps) / 10_000n;
  const newTick = sqrtPriceX96ToTick(newSqrtPriceX96);

  const newWord = repackSlot0(rawWord, newSqrtPriceX96, newTick);
  const storageHex = zeroPadValue(toBeHex(newWord), 32);
  const slotHex = zeroPadValue(toBeHex(storageSlotIndex), 32);

  await provider.send("anvil_setStorageAt", [poolAddress, slotHex, storageHex]);

  const slot0After = await readSlot0(provider, poolAddress);

  const priceBefore = Number(slot0Before.sqrtPriceX96) ** 2 / 2 ** 192;
  const priceAfter = Number(slot0After.sqrtPriceX96) ** 2 / 2 ** 192;
  const priceMovePercent = ((priceAfter - priceBefore) / priceBefore) * 100;

  logger.info("divergence created via slot0 manipulation", {
    poolAddress,
    originalSqrtPriceX96: slot0Before.sqrtPriceX96.toString(),
    newSqrtPriceX96: slot0After.sqrtPriceX96.toString(),
    originalTick: slot0Before.tick,
    newTick,
    verifyTick: slot0After.tick,
    priceMovePercent: priceMovePercent.toFixed(4),
  });

  return {
    poolAddress,
    originalSqrtPriceX96: slot0Before.sqrtPriceX96,
    newSqrtPriceX96: slot0After.sqrtPriceX96,
    priceMovePercent,
  };
}

async function main(): Promise<void> {
  const poolAddress = process.argv[2];
  const priceDeltaBps = parseInt(process.argv[3] || "30", 10);
  const anvilPort = parseInt(process.env.ANVIL_PORT || "8545", 10);

  if (!poolAddress) {
    console.error("Usage: npx ts-node scripts/create-fork-divergence.ts <poolAddress> [priceDeltaBps]");
    process.exit(1);
  }

  const provider = new JsonRpcProvider(`http://127.0.0.1:${anvilPort}`);

  try {
    const result = await createDivergence(provider, poolAddress, "", "", 0, 0n, priceDeltaBps);
    console.log("\nDivergence created:");
    console.log(`  Pool: ${result.poolAddress}`);
    console.log(`  Price move: ${result.priceMovePercent.toFixed(4)}%`);
  } catch (err) {
    console.error("Failed:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
