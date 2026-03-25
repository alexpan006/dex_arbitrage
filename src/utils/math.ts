const Q96 = 2n ** 96n;

export function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

export function sqrtPriceX96ToPriceFloat(sqrtPriceX96: bigint): number {
  const sqrt = Number(sqrtPriceX96) / Number(Q96);
  return sqrt * sqrt;
}

export function relativeDiffBps(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return 0;
  }

  const mid = (a + b) / 2;
  if (mid <= 0) {
    return 0;
  }

  return Math.abs((a - b) / mid) * 10_000;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Estimate the approximate token0 amount available around the current tick
 * in a Uniswap V3 / PancakeSwap V3 pool.
 *
 * Uses the concentrated-liquidity formula: token0 ≈ L / sqrtPrice.
 * Since sqrtPriceX96 = sqrtPrice × 2^96, this becomes:
 *   token0 ≈ L × 2^96 / sqrtPriceX96
 *
 * This is a rough estimate (actual depth depends on tick range distribution),
 * but it's good enough to cap borrow amounts at a sane fraction of pool depth.
 */
export function estimateToken0Available(sqrtPriceX96: bigint, liquidity: bigint): bigint {
  if (sqrtPriceX96 <= 0n || liquidity <= 0n) {
    return 0n;
  }
  return (liquidity * Q96) / sqrtPriceX96;
}
