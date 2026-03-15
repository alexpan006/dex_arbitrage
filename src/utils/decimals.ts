export function scaleTo1e18(amount: bigint, decimals: number): bigint {
  if (decimals === 18) {
    return amount;
  }

  if (decimals > 18) {
    return amount / 10n ** BigInt(decimals - 18);
  }

  return amount * 10n ** BigInt(18 - decimals);
}

export function scaleFrom1e18(amount1e18: bigint, decimals: number): bigint {
  if (decimals === 18) {
    return amount1e18;
  }

  if (decimals > 18) {
    return amount1e18 * 10n ** BigInt(decimals - 18);
  }

  return amount1e18 / 10n ** BigInt(18 - decimals);
}

export function formatUnitsBigInt(amount: bigint, decimals: number, precision = 6): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;

  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;

  const fractionString = fraction.toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
  const signedWhole = negative ? `-${whole.toString()}` : whole.toString();

  return fractionString.length > 0 ? `${signedWhole}.${fractionString}` : signedWhole;
}
