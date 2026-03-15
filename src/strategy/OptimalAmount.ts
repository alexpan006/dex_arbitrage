import { PoolState } from "../feeds/PoolStateCache";
import { clamp, relativeDiffBps, sqrtPriceX96ToPriceFloat } from "../utils/math";

export interface OptimalAmountInput {
  buyPool: PoolState;
  sellPool: PoolState;
  maxBorrowToken0: bigint;
}

export interface OptimalAmountResult {
  amountInToken0: bigint;
  estimatedGrossBps: number;
  sampleProfits: [number, number, number];
}

export function sampleAmounts(maxBorrowToken0: bigint): [bigint, bigint, bigint] {
  const min = 10n ** 15n;
  const max = maxBorrowToken0 > min ? maxBorrowToken0 : min;

  const x1 = (max * 2n) / 10n;
  const x2 = (max * 5n) / 10n;
  const x3 = (max * 8n) / 10n;

  return [x1 > min ? x1 : min, x2 > min ? x2 : min, x3 > min ? x3 : min];
}

function toFloatToken0(amount: bigint): number {
  return Number(amount) / 1e18;
}

function toBigIntToken0(value: number): bigint {
  if (value <= 0) {
    return 0n;
  }
  return BigInt(Math.floor(value * 1e18));
}

function estimateProfitForAmount(
  buyPrice: number,
  sellPrice: number,
  feeBuyBps: number,
  feeSellBps: number,
  amountToken0: number
): number {
  if (amountToken0 <= 0) {
    return 0;
  }

  const tokens1Out = amountToken0 * buyPrice * (1 - feeBuyBps / 10_000);
  const token0Back = (tokens1Out / sellPrice) * (1 - feeSellBps / 10_000);
  return token0Back - amountToken0;
}

function solveParabolicVertex(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): number {
  const d12 = (y2 - y1) / (x2 - x1);
  const d23 = (y3 - y2) / (x3 - x2);
  const a = (d23 - d12) / (x3 - x1);
  const b = d12 - a * (x1 + x2);

  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= 0) {
    return x2;
  }

  return -b / (2 * a);
}

export class OptimalAmountCalculator {
  compute(input: OptimalAmountInput): OptimalAmountResult {
    const buyPrice = sqrtPriceX96ToPriceFloat(input.buyPool.sqrtPriceX96);
    const sellPrice = sqrtPriceX96ToPriceFloat(input.sellPool.sqrtPriceX96);
    const feeBuyBps = input.buyPool.fee / 100;
    const feeSellBps = input.sellPool.fee / 100;

    const maxAmount = Math.max(0.001, toFloatToken0(input.maxBorrowToken0));
    const x1 = clamp(maxAmount * 0.2, 0.001, maxAmount);
    const x2 = clamp(maxAmount * 0.5, 0.001, maxAmount);
    const x3 = clamp(maxAmount * 0.8, 0.001, maxAmount);

    const y1 = estimateProfitForAmount(buyPrice, sellPrice, feeBuyBps, feeSellBps, x1);
    const y2 = estimateProfitForAmount(buyPrice, sellPrice, feeBuyBps, feeSellBps, x2);
    const y3 = estimateProfitForAmount(buyPrice, sellPrice, feeBuyBps, feeSellBps, x3);

    let bestAmount = solveParabolicVertex(x1, y1, x2, y2, x3, y3);
    bestAmount = clamp(bestAmount, 0.001, maxAmount);

    const grossBps = relativeDiffBps(sellPrice, buyPrice);

    return {
      amountInToken0: toBigIntToken0(bestAmount),
      estimatedGrossBps: grossBps,
      sampleProfits: [y1, y2, y3],
    };
  }
}
