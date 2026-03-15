import { Dex } from "../config/pools";

export interface PoolStaticMeta {
  poolAddress: string;
  dex: Dex;
  token0: string;
  token1: string;
  fee: number;
}

export interface PoolDynamicState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  blockNumber: number;
  updatedAtMs: number;
}

export interface PoolState extends PoolStaticMeta, PoolDynamicState {}

function stateKey(dex: Dex, poolAddress: string): string {
  return `${dex}:${poolAddress.toLowerCase()}`;
}

export class PoolStateCache {
  private readonly states = new Map<string, PoolState>();

  upsert(meta: PoolStaticMeta, dynamic: PoolDynamicState): PoolState {
    const key = stateKey(meta.dex, meta.poolAddress);
    const next: PoolState = { ...meta, ...dynamic };
    this.states.set(key, next);
    return next;
  }

  get(dex: Dex, poolAddress: string): PoolState | undefined {
    return this.states.get(stateKey(dex, poolAddress));
  }

  getAll(): PoolState[] {
    return [...this.states.values()];
  }

  getByPair(tokenA: string, tokenB: string): PoolState[] {
    const left = tokenA.toLowerCase();
    const right = tokenB.toLowerCase();

    return this.getAll().filter((state) => {
      const token0 = state.token0.toLowerCase();
      const token1 = state.token1.toLowerCase();
      return (token0 === left && token1 === right) || (token0 === right && token1 === left);
    });
  }

  pruneOlderThan(cutoffMs: number): number {
    const before = this.states.size;

    for (const [key, state] of this.states.entries()) {
      if (state.updatedAtMs < cutoffMs) {
        this.states.delete(key);
      }
    }

    return before - this.states.size;
  }

  clear(): void {
    this.states.clear();
  }

  size(): number {
    return this.states.size;
  }
}
