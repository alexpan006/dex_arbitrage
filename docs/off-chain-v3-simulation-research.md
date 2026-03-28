# Off-Chain Uniswap V3 Swap Simulation — Research Notes

> Date: 2026-03-28  
> Status: Research only — not yet implemented  
> Context: Our DEX arb bot currently uses on-chain QuoterV2 `eth_call` for swap simulation (~100ms/call). This doc explores eliminating that RPC dependency via local swap simulation.

---

## Problem Statement

Each trade-size evaluation costs 2 RPC calls (leg 1 quote + leg 2 quote). With 7-10 grid points, that's 14-20 RPC calls per optimization (~1.5-2s). BSC block time is 0.45s. We can't search aggressively without blowing our latency budget.

**Goal**: Simulate V3 swaps locally so evaluations cost <1ms instead of ~100ms, enabling brute-force sweeps and real-time optimization.

---

## How Production Rust MEV Bots Do It

### Key Finding: They DON'T Maintain Full V3 State Locally

The dominant approach is **REVM (Rust EVM)** — fork the entire EVM state at each block, then execute the *actual Quoter contract bytecode* locally. No manual tick traversal, no event-driven state sync for ticks.

### 1. REVM Approach (pawurb/univ3-revm-arbitrage)

**How it works**:
1. Create `CacheDB<AlloyDB>` backed by an RPC provider
2. On first call, REVM fetches storage slots on-demand via `eth_getStorageAt`
3. Subsequent calls hit the local cache — no more RPC
4. Execute actual Uniswap V3 Quoter contract bytecode in the local EVM

**Performance** (from Pawel Urbanek's benchmarks):
| Method | First Call | Subsequent 100 calls | RPC Requests |
|--------|-----------|---------------------|--------------|
| `eth_call` | 52ms | 4.39s (100 calls) | 100 |
| Anvil fork | 759ms | 109ms | 36 (initial) |
| REVM | 935ms | 70ms | 33 (initial) |
| REVM + mocked ERC20 | 387ms | 72ms | 10 |

**Key optimization**: Replace ERC20 token bytecode with minimal mock (only `balanceOf`/`transferFrom`), reducing initial RPC from 33→10 calls.

**Repo**: https://github.com/pawurb/univ3-revm-arbitrage  
**Blog**: https://pawelurbanek.com/revm-alloy-anvil-arbitrage

### 2. Dexloom/Loom Architecture

**Status**: Now proprietary (SombraX). Active fork: [cakevm/kabu](https://github.com/cakevm/kabu).

**Architecture**:
- Uses REVM `DatabaseRef` to simulate contract calls locally
- **Does NOT implement tick traversal math** — runs actual EVM bytecode
- Event-driven pool discovery via `Broadcaster<MessageBlockLogs>`
- On-demand storage slot fetching per block, with "read-only cells" caching

**State sync**:
- Subscribes to block logs for new pool discovery only
- Fetches changed storage slots via `eth_getStorageAt` per block (~5-15 RPC calls)
- Uses `MarketState<DB>` with `apply_geth_update()` for incremental updates
- `read_only_cells` optimization: marks immutable storage slots (factory, fee, tokens) to skip re-fetching

**Reorg handling**: Basic — restart simulation from latest confirmed block. No fancy rollback.

**Repo**: https://github.com/dexloom/loom (archived), https://github.com/cakevm/kabu (fork)

### 3. 0xKitsune/uniswap-v3-math

**What it is**: Pure Rust math library — just the formulas, no state management.

**Implements**:
- `compute_swap_step()` — single tick swap calculation
- `get_sqrt_ratio_at_tick()`, `get_tick_at_sqrt_ratio()`
- Tick bitmap traversal helpers

**What it does NOT do**: Multi-tick swap loop, state management, event subscription.

**You must provide**: `sqrtPriceX96`, `liquidity`, `tick`, `feeProtocol`, tick bitmap, individual tick data.

**Repo**: https://github.com/0xKitsune/uniswap-v3-math

---

## Why Our Previous Off-Chain Attempt Failed

V3 has **too much state** to track via events:

1. **Tick bitmap**: 256-bit integers at `tickBitmap[wordPos]` — changes on every Mint/Burn
2. **Per-tick liquidity**: `ticks[tick].liquidityGross` and `liquidityNet` — changes on Mint/Burn
3. **Active liquidity**: Changes on every swap that crosses a tick boundary
4. **sqrt price**: Changes on every swap

To simulate a multi-tick swap, you need ALL of this data. The events (Swap, Mint, Burn) give you:
- **Swap**: new `sqrtPriceX96`, `tick`, `liquidity` (sufficient for slot0 tracking)
- **Mint/Burn**: `tickLower`, `tickUpper`, `amount` — but NOT the resulting tick bitmap or cumulative tick data

So you can't reconstruct tick bitmap state from events alone — you need `eth_getStorageAt` for the specific bitmap words and tick data slots that a swap might cross. For a swap crossing N ticks, that's ~3N storage reads.

**This is why REVM wins**: It fetches these slots on-demand during simulation, caches them, and doesn't require you to pre-fetch or maintain them.

---

## TypeScript Feasibility

### Option A: REVM Microservice (Recommended for Production)

Run a lightweight Rust sidecar that:
1. Forks BSC state per block via REVM
2. Exposes HTTP/WebSocket API: `POST /quote { pool, amountIn, zeroForOne }` → `{ amountOut }`
3. TypeScript bot calls this for all simulations
4. Batch endpoint: `POST /batch-quote { quotes: [...] }` for grid optimization

**Pros**: Fastest (70ms/100 sims), most accurate, avoids state sync problem entirely  
**Cons**: Extra infrastructure (Rust binary + IPC), needs maintenance

**Implementation sketch**:
```
┌──────────────┐     HTTP/WS      ┌─────────────────┐
│  TS Arb Bot  │ ◄──────────────► │  Rust REVM Svc  │
│  (strategy)  │   /batch-quote   │  (simulation)   │
└──────────────┘                  └────────┬────────┘
                                           │ eth_getStorageAt
                                           │ (on-demand, cached)
                                  ┌────────▼────────┐
                                  │   BSC RPC Node   │
                                  └─────────────────┘
```

### Option B: TypeScript compute_swap_step (ParaSwap DexLib)

**ParaSwap's DexLib** has a production TypeScript implementation:

**Repo**: https://github.com/VeloraDEX/paraswap-dex-lib  
**Key files**:
- `src/dex/uniswap-v3/contract-math/SwapMath.ts` — `computeSwapStep()`
- `src/dex/uniswap-v3/contract-math/uniswap-v3-math.ts` — multi-tick swap loop

**What you'd need to build on top**:
1. State fetching layer (slot0 + liquidity + relevant ticks per block)
2. Tick bitmap cache with event-driven invalidation
3. Per-tick liquidity data cache
4. Event subscription: Swap (update slot0/liquidity), Mint/Burn (invalidate tick caches)

**Performance**: JavaScript BigInt is ~10-20x slower than Rust U256, but for single optimization (10-20 swaps), the difference is ~5-50ms total — acceptable.

**Pros**: No extra infrastructure, pure TypeScript  
**Cons**: Must solve the state sync problem ourselves, significant implementation effort (~500+ lines of precision-critical math + caching)

### Option C: Minimal Event Tracking (Approximation)

Track only `slot0` + `liquidity` from Swap events. Approximate single-tick swaps locally. Use QuoterV2 for final confirmation only.

```typescript
// Listen to Swap events (we already do this in EventListener)
pool.on('Swap', (_, _, amount0, amount1, sqrtPriceX96, liquidity, tick) => {
  this.slot0 = { sqrtPriceX96, tick };
  this.liquidity = liquidity;
});

// Fast local approximation (single-tick only)
function approximateSwapOut(amountIn: bigint, pool: LocalPoolState): bigint {
  // compute_swap_step with current liquidity only
  // Accurate when swap doesn't cross a tick boundary
  // Underestimates output for large swaps (conservative)
}
```

**Pros**: Simple, fast, uses existing event infrastructure  
**Cons**: Inaccurate for large swaps that cross ticks, still need QuoterV2 for confirmation

---

## Events to Monitor for Full State Sync

If we ever implement full local state (Option B):

| Event | Fields | State Updated | Priority |
|-------|--------|---------------|----------|
| **Swap** | sqrtPriceX96, tick, liquidity | slot0, active liquidity | Must have |
| **Mint** | tickLower, tickUpper, amount | ticks[], tickBitmap, liquidity | Must have |
| **Burn** | tickLower, tickUpper, amount | ticks[], tickBitmap, liquidity | Must have |
| **Flash** | — | None (atomic) | Ignore |
| **Initialize** | sqrtPriceX96, tick | slot0 | New pools only |
| **Collect** | — | None (fee withdrawal) | Ignore |

**PancakeSwap V3 note**: Swap event has 9 params (vs Uniswap's 7) — different topic0. We already handle this in EventListener.

---

## Recommended Path Forward

### Phase 1 (Now): Adaptive Grid + QuoterV2
- Log-scale grid with 7-10 points
- Batch RPC calls where possible
- Good enough for initial profitability testing

### Phase 2 (If profitable): REVM Microservice
- Build Rust sidecar with REVM
- Expose batch-quote HTTP API
- Keep TypeScript for strategy, Rust for simulation
- Enables brute-force optimization (1000 points in <100ms)

### Phase 3 (Competitive MEV): Full Rust Rewrite
- Port entire strategy to Rust (like loom/kabu)
- Sub-millisecond simulation
- Direct mempool monitoring
- This is the endgame for competitive MEV on BSC

---

## Key Resources

- **Pawel Urbanek REVM tutorial**: https://pawelurbanek.com/revm-alloy-anvil-arbitrage
- **Pawel Urbanek Yul/Huff gas optimization**: https://pawelurbanek.com/mev-yul-huff-gas
- **pawurb/univ3-revm-arbitrage** (Rust): https://github.com/pawurb/univ3-revm-arbitrage
- **dexloom/loom** (Rust, archived): https://github.com/dexloom/loom
- **cakevm/kabu** (Loom fork, active): https://github.com/cakevm/kabu
- **0xKitsune/uniswap-v3-math** (Rust math only): https://github.com/0xKitsune/uniswap-v3-math
- **ParaSwap DexLib** (TypeScript V3 math): https://github.com/VeloraDEX/paraswap-dex-lib
- **Fausto Uribe V3 pricing** (Python): https://faustware.net/2023/05/19/univ3-pricing-functions
- **HAL V3 math paper**: https://hal.science/hal-04214315v2
- **arXiv profit maximization**: https://arxiv.org/pdf/2406.16600
