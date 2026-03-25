# RPC & Latency Optimization Roadmap

## Current RPC Call Flow

### Phase 1: Block Notification (WSS push — 0 RPC)

The WebSocket provider emits a `"block"` event on each new BSC block (~0.45s).
PriceFeed subscribes to this event and triggers `refresh()`.

### Phase 2: Pool State Refresh (1 RPC call — ~100ms)

`PriceFeed.refresh()` batches `slot0()` + `liquidity()` for all 10 monitored pools
into a single `Multicall3.aggregate3()` call. This is efficient — 20 sub-calls batched
into 1 RPC round-trip.

Result: `sqrtPriceX96`, `liquidity`, `tick` cached for every pool.

### Phase 3: Spread Check (0 RPC — pure math, <1ms)

`OpportunityDetector.detect()` iterates all 5 pairs:
- Computes `uniPrice` and `pcsPrice` from cached `sqrtPriceX96`
- Computes `spreadBps` via `relativeDiffBps()`
- If `spreadBps < minSpreadBps` → skip (no RPC needed)

In the 6-hour overnight run, **95.7% of records** were rejected here. This is the most
effective filter — it costs zero RPC calls.

### Phase 4: Optimizer Quoting (10-22 → 10-22 RPC calls per pair, but parallelized via OPT-4)

For each pair that passes the spread check:

```
HybridAmountOptimizer.optimize()
  │
  ├─ Coarse sweep: 5 amounts via parallel Promise.all (OPT-4)
  │    🟢 Batch Leg 1: Promise.all[QuoterV2 × 5] — all token0→token1 on buyPool (5 RPCs in parallel)
  │    🟢 Batch Leg 2: Promise.all[QuoterV2 × 5] — all token1→token0 on sellPool (5 RPCs in parallel)
  │    Note: Multicall3 batching was attempted but failed — QuoterV2 uses internal
  │    revert trick incompatible with Multicall3's CALL opcode (see OPT-4 details below)
  │
  ├─ Parabolic interpolation: 0-1 quoteRoundTrip = 0-2 RPC calls
  │
  ├─ Golden-section refinement: 1-3 quoteRoundTrips = 2-6 RPC calls (~1s)
  │
  └─ Confirmation quote: 1 quoteRoundTrip = 2 RPC calls (~0.4s)

Total per pair: 10-22 RPC calls (same count as before), but coarse sweep parallelized
Multiple pairs now quoted in PARALLEL via Promise.all() (OPT-2)
```

### Phase 5: Execution (only if profitable — 2-3 RPC calls)

If an opportunity passes all checks:
- `GasEstimator.estimateGas()` — 1 RPC call
- `PrivateTxSubmitter.submit()` — 1 RPC call (to builder or public)
- Receipt polling — 1+ RPC calls

### Summary Table

| Phase                | RPC Calls      | Time     | Notes                          |
|----------------------|---------------|----------|--------------------------------|
| Block notification   | 0             | instant  | WSS push                       |
| Pool state refresh   | 1 (multicall) | ~100ms   | Batches 20 sub-calls           |
| Spread check         | 0             | <1ms     | Pure math, filters 95%+        |
| **Quoting per pair** | **10-22**     | **0.5-2s** | **Coarse parallelized via Promise.all (OPT-4), pairs in parallel (OPT-2)** |
| Execution            | 2-3           | ~500ms   | Only when profitable           |

---

## Current Block-Behind Handling

The bot uses a **skip-and-rerun** pattern (see `src/index.ts` lines 93-110):

```
detectionInFlight = true    — lock: detection is running
rerunAfterCurrent = true    — flag: new block(s) arrived while busy
```

**Behavior**:
1. Block N arrives → detection starts (4-6 seconds)
2. Blocks N+1 through N+10 arrive while detection runs
   - PriceFeed refreshes cache on each block (multicall keeps state fresh)
   - Detection callback sets `rerunAfterCurrent = true` and returns immediately
3. Detection for block N finishes
4. Sees `rerunAfterCurrent = true` → runs detection again with **latest cached state**
5. Intermediate blocks are effectively skipped — we always work on freshest data

**This is correct for arbitrage** — we don't want to queue stale blocks. But the problem
remains: the quotes we get from QuoterV2 during the 4-6 second detection window reflect
the pool state at quote-time, which may be stale by the time we'd submit a TX.

At 0.45s block time and ~4s detection duration, we're **~9 blocks behind** when we finish.
Any opportunity discovered may already be captured by faster bots.

---

## Optimization Roadmap

### OPT-1: Raise `minSpreadBps` (Zero-cost, immediate)

**Current**: `minSpreadBps = 2` (testing value)
**Recommended production value**: 8-10 bps

**Why**: With 5 bps fee on the sell leg (fee tier 500), any spread under 5 bps is
**guaranteed unprofitable** before slippage. In practice, slippage adds another 2-5 bps.
The overnight run showed 0 profitable quotes across all spread levels — most spreads were
under 5 bps.

**Impact**: Eliminates ~99% of wasted quote RPC calls. Saves ~30 RPC calls per detection
cycle that had no chance of profitability.

**Implementation**: Change `minSpreadBps` in `OpportunityDetector.ts` DEFAULT_OPTIONS,
or make it configurable via `.env` (preferred).

**Status**: Deferred — currently lowered for testing/data collection.

### OPT-2: Parallel Quoting Across Pairs

**Current**: ~~Pairs are quoted sequentially in a `for` loop.~~
**Implemented**: `detect()` now collects qualified pairs in Phase A (spread check), then runs
all `findBestCandidate()` calls in parallel via `Promise.all()` in Phase B.

```typescript
// Phase A: collect qualified pairs (pure math, no RPC)
// Phase B: quote all in parallel
const pairResults = await Promise.all(
  qualifiedPairs.map(qp => this.findBestCandidate(qp.buyPool, qp.sellPool, qp.bounds))
);
```

**Impact**: If 2 pairs pass spread check, wall-clock time drops from ~10s → ~5s.
RPC call count stays the same, but they overlap in time.

**Risk**: Free-tier RPC rate limits may throttle parallel calls. Monitor for 429 errors.

**Status**: ✅ DONE

### OPT-3: Fewer Coarse Points

**Previous**: 7 coarse ratios `[1000, 2000, 3500, 5000, 6500, 8000, 9000]` = 14 RPC calls.
**Implemented**: 5 coarse ratios `[1500, 3500, 5500, 7500, 9000]` = 10 RPC calls.
`maxQuoteEvaluations` reduced from 16 → 13 (worst case: 5+1+2+3=11, with 2 headroom).

**Impact**: Saves 4 RPC calls per pair (~1-1.5s). The parabolic + golden-section
refinement compensates for reduced coarse coverage — it already narrows to the optimum
efficiently.

**Risk**: May miss the global optimum if the profit curve has multiple peaks. In practice
V3 concentrated liquidity creates a single-peaked profit curve, so this should be safe.

**Status**: ✅ DONE

### OPT-4: Parallel Coarse Quotes via Promise.all

**Previous**: Each `QuoterV2.quoteExactInputSingle()` was a separate sequential `eth_call` RPC.
**Attempted**: Multicall3.aggregate3() batching — **FAILED** (see below).
**Implemented**: `Promise.all()` parallel individual `staticCall`s.

#### Why Multicall3 Failed

QuoterV2's `quoteExactInputSingle` internally performs a real swap in a `try` block,
then the swap callback deliberately **reverts** with the result encoded in revert data.
When called directly via `staticCall` at the RPC level, the EVM captures the output
before discarding state changes. But when called through Multicall3's `CALL` opcode
(even within a `staticCall` context), the inner revert bubbles up and Multicall3 catches
it as a failure (`success=false`, `returnData=0x`). All sub-calls return empty `0x`.

This is a fundamental EVM limitation — **QuoterV2 is incompatible with Multicall3**.

#### Current Implementation

```
Previous (5 coarse amounts, sequential leg-by-leg):
  Leg1_amt1 → Leg1_amt2 → ... → Leg1_amt5    (5 sequential RPCs)
  Leg2_amt1 → Leg2_amt2 → ... → Leg2_amt5    (5 sequential RPCs)

Now (parallel all leg1 calls, then parallel all leg2 calls):
  Promise.all[Leg1_amt1, Leg1_amt2, ..., Leg1_amt5]  (5 RPCs in parallel)
  Promise.all[Leg2_amt1, Leg2_amt2, ..., Leg2_amt5]  (5 RPCs in parallel)
```

**Implementation**:
- `QuoterService.batchQuoteExactInputSingle()` — fires multiple `quoteExactInputSingle()`
  calls in parallel via `Promise.all`. Individual failures return null (graceful degradation).
- `HybridAmountOptimizer.optimize()` — accepts optional `batchEvaluateProfit` callback.
  When provided, coarse phase collects all amounts upfront and calls batch once.
  Parabolic + GSS phases still use single evaluator (1-2 calls each, not worth batching).
- `OpportunityDetector.batchQuoteRoundTrips()` — parallel leg1 → extract amountOuts
  → parallel leg2. Wired into `findBestCandidate()` as the batch evaluator.

**Impact**: RPC call count unchanged (10 per coarse sweep), but wall-clock time
drops from ~2s sequential → ~0.5s parallel for the coarse phase.

**Caveat**: Sends more concurrent RPCs, which exacerbates Chainstack free-tier rate
limiting. In the 5-min smoke test, 82 explicit rate limit errors were logged, and
PriceFeed multicall failed on both providers 144 times (often due to rate limiting
manifesting as `missing revert data`). Despite this, **pair-level quote success rate
was 100%** — all 306 pair-level quote attempts succeeded. The 59% block-level failure
rate came from the coarse sweep batch failing under rate limiting, with the optimizer
gracefully falling back.

**Status**: ✅ DONE (but rate limiting on free tier is a concern — paid RPC recommended)

### OPT-5: Event-Driven Monitoring (Ultimate fix)

**Current**: Block-based polling — on every block, multicall refreshes all pool states,
then detection runs against all pairs.

**Proposed**: Subscribe to `Swap`, `Mint`, `Burn` events on monitored pool addresses.
On a Swap event, the event payload directly provides the new `sqrtPriceX96`, `liquidity`,
`tick` — no additional RPC needed to get pool state. Detection triggers immediately for
the **affected pair only**, not all pairs.

**Impact**:
- Eliminates the per-block multicall entirely when events are flowing
- Detection triggers only when a pool actually changes, not every 0.45s
- Can react within ~50ms of event propagation vs ~450ms+ for next-block polling
- Quote only the affected pair → fewer RPC calls per trigger

**Architecture**:
```
Single WSS subscription for all monitored pools:
  topic0 = keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")
  addresses = [pool1, pool2, ..., pool10]

On Swap event:
  1. Parse sqrtPriceX96, liquidity, tick from event data
  2. Update PoolStateCache for the affected pool
  3. Compute spread for the affected pair only
  4. If spread > threshold → run optimizer for that pair only
  5. Keep block-based polling as fallback (reduced frequency, e.g., every 10 blocks)
```

See `docs/TODO_EVENT_DRIVEN_MONITORING.md` for the full design.

**Status**: TODO — documented, not yet implemented.

### OPT-6: Paid / Co-located RPC

**Current**: Chainstack free tier (HTTP + WSS).
**Options**:
- Chainstack paid tier (~$30/mo): lower latency, higher rate limits
- Alchemy BSC (configured in .env but unused): alternative to benchmark
- QuickNode: another option
- Self-hosted BSC node: lowest latency, highest cost (~$100+/mo VPS + storage)

**Impact**: ~50-100ms per call improvement over free tier. Meaningful only **after**
reducing total call count via OPT-1 through OPT-4.

**Status**: Low priority — optimize call count first.

---

## Priority Order

| Priority | Optimization                  | Effort   | Impact       | Status |
|----------|-------------------------------|----------|--------------|--------|
| 1        | OPT-1: Raise minSpreadBps     | Trivial  | High         | Deferred (testing) |
| 2        | OPT-4: Parallel coarse quotes | Moderate | Medium-High  | ✅ DONE (Promise.all, not Multicall3) |
| 3        | OPT-2: Parallel pair quoting  | Low      | Medium       | ✅ DONE |
| 4        | OPT-3: Fewer coarse points    | Low      | Medium       | ✅ DONE |
| 5        | OPT-5: Event-driven monitoring| High     | Transformative| TODO   |
| 6        | OPT-6: Paid RPC              | Trivial  | Low          | TODO   |

OPT-4 (parallel coarse quotes) addressed the coarse sweep bottleneck: 10 sequential RPCs
→ 10 parallel RPCs via Promise.all. Multicall3 batching was attempted but QuoterV2's
internal revert trick is fundamentally incompatible with Multicall3's CALL opcode.
The Promise.all approach reduces wall-clock time but not RPC call count, and increases
concurrent request load which exacerbates free-tier rate limiting.

Combined with OPT-2 (parallel pairs) and OPT-3 (fewer points), total detection time
dropped from ~2.8s mean to ~633ms mean — a **77% improvement**. However, rate limiting
caused 59% of coarse sweep batches to fail. A paid RPC tier would likely eliminate this.

OPT-5 (event-driven) is the long-term goal but requires the most architectural change.
It fundamentally changes the trigger model from "check everything every block" to
"react to what changed."
