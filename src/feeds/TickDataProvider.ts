import { Contract, Interface, JsonRpcProvider } from "ethers";
import { createLogger } from "../utils/logger";

const logger = createLogger("TickDataProvider");

const POOL_TICK_ABI = [
  "function tickSpacing() external view returns (int24)",
  "function ticks(int24 tick) external view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized)",
] as const;

export interface TickSnapshot {
  tick: number;
  liquidityGross: bigint;
  liquidityNet: bigint;
  initialized: boolean;
}

export class TickDataProvider {
  private readonly provider: JsonRpcProvider;
  private readonly iface = new Interface(POOL_TICK_ABI);

  constructor(provider: JsonRpcProvider) {
    this.provider = provider;
  }

  async getTickSpacing(poolAddress: string): Promise<number> {
    const pool = new Contract(poolAddress, this.iface, this.provider);
    const spacing = await pool.tickSpacing();
    return Number(spacing);
  }

  async getTicks(poolAddress: string, ticks: number[]): Promise<TickSnapshot[]> {
    const pool = new Contract(poolAddress, this.iface, this.provider);
    const results: TickSnapshot[] = [];

    for (const tick of ticks) {
      try {
        const raw = await pool.ticks(tick);
        results.push({
          tick,
          liquidityGross: BigInt(raw.liquidityGross),
          liquidityNet: BigInt(raw.liquidityNet),
          initialized: Boolean(raw.initialized),
        });
      } catch (error) {
        logger.warn("tick fetch failed", { poolAddress, tick, error: String(error) });
      }
    }

    return results;
  }

  async getCenteredTickWindow(poolAddress: string, currentTick: number, radius: number): Promise<TickSnapshot[]> {
    if (radius <= 0) {
      return [];
    }

    const spacing = await this.getTickSpacing(poolAddress);
    const alignedCenter = Math.floor(currentTick / spacing) * spacing;

    const ticks: number[] = [];
    for (let i = -radius; i <= radius; i += 1) {
      ticks.push(alignedCenter + i * spacing);
    }

    return this.getTicks(poolAddress, ticks);
  }
}
