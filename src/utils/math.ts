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
