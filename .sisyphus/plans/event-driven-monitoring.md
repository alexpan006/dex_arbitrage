# Plan: Event-Driven Pool Monitoring (OPT-5)

## Objective

Replace block-polling as the primary pool state update mechanism with WebSocket log subscriptions for Swap, Mint, and Burn events. Keep block-polling as a fallback safety net. This changes the trigger model from "refresh all pools every block" to "react to the specific pool that changed."

## Current Architecture

```
[WSS "block" event] → PriceFeed.refresh() → Multicall3(slot0 + liquidity × 10 pools)
                                           → OpportunityDetector.detect(allPools)
```

**Problems:**
1. Polls all 10 pools every 0.45s even when nothing changed
2. Detection runs against all 5 pairs regardless of which pool moved
3. ~100ms per multicall refresh = burned RPC budget
4. Rate limiting from parallel quote RPCs + PriceFeed refresh competing for RPS

## Target Architecture

```
[WSS "logs" subscription] → EventListener → parse event → update PoolStateCache
                                          → trigger detection for AFFECTED PAIR ONLY
[WSS "block" event (every N blocks)] → PriceFeed.refresh() (fallback only)
```

**Benefits:**
1. Zero-RPC Swap handling — event carries sqrtPriceX96, tick, liquidity directly
2. Only quote the pair that moved — 1 pair instead of 5
3. React within ~100-300ms of block inclusion vs ~450ms+ polling delay
4. Dramatically fewer RPC calls (no per-block multicall)

---

## Critical Design Decisions

### D1: PancakeSwap Swap event differs from Uniswap

PancakeSwap V3 Swap event has **9 parameters** (adds `protocolFeesToken0`, `protocolFeesToken1`) vs Uniswap's 7. This means **different topic0 hashes**:

| DEX | Swap Event Signature | topic0 |
|-----|---------------------|--------|
| Uniswap V3 | `Swap(address,address,int256,int256,uint160,uint128,int24)` | `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67` |
| PancakeSwap V3 | `Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)` | `0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83` |

**Decision**: Use a single `eth_subscribe("logs")` with a topic0 array containing BOTH signatures, plus Mint and Burn. The subscription filter supports OR-matching on topics[0].

### D2: Mint/Burn events require follow-up RPC

Swap events carry full state (sqrtPriceX96, tick, liquidity) — zero RPC needed.
Mint/Burn events only carry the liquidity **delta**, not the new total. And they only affect `liquidity` if the current tick is within the position's [tickLower, tickUpper] range.

**Decision**: On Mint/Burn, do a targeted single-pool multicall (slot0 + liquidity) for JUST the affected pool. This is 1 RPC vs 10-pool multicall. Alternatively, we can compute the delta locally if tick is in range, but the single-pool call is simpler and safer.

### D3: Single subscription vs per-pool subscriptions

**Decision**: Single subscription with address array (all 10 pool addresses) and topic0 array (4 event signatures). This is 1 WSS subscription vs 10+. Easier reconnection logic, lower overhead. Parse `log.address` to route to the correct pool handler.

### D4: Fallback poll frequency

**Decision**: Keep block-based polling but reduce to every **10 blocks** (~4.5s) instead of every block. This catches any missed events from WSS disconnection gaps. The poll is still a full multicall refresh of all pools.

### D5: Event deduplication

WSS can deliver duplicate events during reorgs or provider failover.

**Decision**: Deduplicate by `transactionHash + logIndex` using an LRU cache (max 5000 entries).

### D6: WSS reconnection & gap backfill

On WSS disconnect, events published during downtime are lost.

**Decision**: 
- Track `lastProcessedBlock` per subscription
- On reconnect, use `eth_getLogs` to backfill from `lastProcessedBlock + 1` to `latest`
- Exponential backoff with jitter on reconnect (1s → 2s → 4s ... max 30s)
- Block-based fallback poll keeps running regardless (safety net)

### D7: Detection trigger — debounce within same block

Multiple Swap events can land in the same block for the same pair. We don't want to trigger detection 5 times.

**Decision**: Debounce per-pair per-block. On first event for a pair in a new block, schedule detection after a 50ms window. If more events arrive for the same pair in the same block within that window, just update the cache — only trigger detection once with the latest state.

---

## Implementation Plan

### File Changes Overview

| File | Change Type | Description |
|------|-------------|-------------|
| `src/feeds/EventListener.ts` | **NEW** | Core event subscription, parsing, dedup, gap backfill |
| `src/feeds/PriceFeed.ts` | **MODIFY** | Add event-driven mode, reduce poll frequency, expose per-pool update |
| `src/feeds/PoolStateCache.ts` | **MODIFY** | Add `upsertSingle()` for targeted pool updates |
| `src/index.ts` | **MODIFY** | Wire up EventListener, adjust detection trigger model |
| `src/config/constants.ts` | **MODIFY** | Add event-related config (poll interval, debounce window) |
| `.env.example` | **MODIFY** | Add `EVENT_DRIVEN_ENABLED`, `FALLBACK_POLL_BLOCKS` |
| `test/unit/EventListener.test.ts` | **NEW** | Unit tests for event parsing, dedup, gap detection |

### Step 1: Create `EventListener` class (`src/feeds/EventListener.ts`)

**Responsibilities:**
- Subscribe to Swap (UNI + PCS signatures), Mint, Burn events via single WSS `eth_subscribe("logs")`
- Parse events with correct ABI per DEX (detect by topic0)
- Deduplicate by txHash+logIndex
- Emit typed events: `onSwap(poolAddress, {sqrtPriceX96, tick, liquidity, blockNumber})` and `onLiquidityChange(poolAddress, blockNumber)`
- Track `lastProcessedBlock` for gap detection
- On WSS reconnection, backfill via `eth_getLogs`
- Expose `start()`, `stop()`, `isRunning()`

**Key implementation details:**

```typescript
// Single subscription filter covering all events on all pools
const filter = {
  address: [...uniswapPoolAddresses, ...pancakePoolAddresses],
  topics: [[
    UNI_SWAP_TOPIC,    // 0xc42079f9...
    PCS_SWAP_TOPIC,    // 0x19b47279...
    MINT_TOPIC,        // 0x7a53080b...
    BURN_TOPIC,        // 0x0c396cd9...
  ]]
};
```

Note: topics[0] as an array means OR — match ANY of these event signatures.

**Swap event parsing** must handle both ABIs:
```typescript
if (log.topics[0] === UNI_SWAP_TOPIC) {
  // Decode: (address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
  // sender and recipient are indexed (in topics[1], topics[2])
  // amount0, amount1, sqrtPriceX96, liquidity, tick are in data
} else if (log.topics[0] === PCS_SWAP_TOPIC) {
  // Same first 5 data fields, plus protocolFeesToken0, protocolFeesToken1
  // We only need sqrtPriceX96, liquidity, tick — ignore the extra fields
}
```

### Step 2: Modify `PriceFeed` to support event-driven updates

**Add:**
- `updateSinglePool(poolAddress, dynamic)` — update cache for ONE pool from event data
- `setFallbackPollInterval(blocks)` — change poll frequency from every-block to every-N-blocks
- Keep existing `refresh()` for fallback polling
- Add a block counter to only call `refresh()` every N blocks

**Key change in `start()`:**
```typescript
// Old: this.wsProvider.on("block", this.blockHandler);
// New:
let blocksSinceLastPoll = 0;
this.wsProvider.on("block", async (blockNumber) => {
  blocksSinceLastPoll++;
  if (blocksSinceLastPoll >= this.fallbackPollInterval) {
    blocksSinceLastPoll = 0;
    await this.refresh(blockNumber);
  }
});
```

### Step 3: Modify `index.ts` detection trigger

**Current flow:**
```
PriceFeed.onUpdate → detect(allPools, blockNumber)
```

**New flow:**
```
EventListener.onSwap(poolAddr, state) → 
  PriceFeed.updateSinglePool(poolAddr, state) →
  find affected pair →
  detect(ONLY affected pair's pools, blockNumber)

EventListener.onLiquidityChange(poolAddr, blockNumber) →
  fetch slot0+liquidity for THAT pool only (1 RPC) →
  PriceFeed.updateSinglePool(poolAddr, state) →
  find affected pair →
  detect(ONLY affected pair's pools, blockNumber)

PriceFeed fallback poll (every 10 blocks) →
  detect(allPools) — same as current behavior
```

**Debounce logic:**
```typescript
const pendingDetections = new Map<string, NodeJS.Timeout>(); // pairKey → timeout

function scheduleDetection(pairKey: string, pools: PoolState[], blockNumber: number) {
  const existing = pendingDetections.get(pairKey);
  if (existing) clearTimeout(existing);
  
  pendingDetections.set(pairKey, setTimeout(async () => {
    pendingDetections.delete(pairKey);
    await detector.detect(pools, blockNumber); // Only this pair's pools
  }, 50)); // 50ms debounce window
}
```

### Step 4: Modify `OpportunityDetector.detect()` to support partial pool sets

Currently `detect()` receives all pool states and internally groups by pair. We need to support receiving just ONE pair's pools for event-triggered detection.

**Approach**: No API change needed. `detect()` already groups pools by pair. If only 2 pools (one pair) are passed, it naturally processes just that pair. The telemetry will record `pairsScanned: 1` instead of 5.

### Step 5: Add config and .env support

```
# .env additions
EVENT_DRIVEN_ENABLED=true          # Enable event-driven mode (default: true)
FALLBACK_POLL_BLOCKS=10            # Fallback multicall every N blocks (default: 10)
EVENT_DEBOUNCE_MS=50               # Debounce window for same-pair events (default: 50)
```

### Step 6: Write unit tests for EventListener

- Test Swap event parsing (both UNI and PCS ABI)
- Test Mint/Burn event parsing
- Test deduplication (same txHash+logIndex ignored)
- Test gap detection (lastProcessedBlock tracking)
- Test debounce (multiple events same pair same block → one callback)

---

## Risk Assessment

### R1: Rate Limiting on Chainstack Free Tier
**Risk**: High. Free tier is 25 RPS. During high-activity blocks with many swaps across 10 pools, events themselves don't cost RPS (they're pushed via WSS). But Mint/Burn follow-up calls + fallback polls do.
**Mitigation**: Event-driven actually REDUCES total RPCs vs current approach. Swap events need 0 RPC. Only Mint/Burn need 1 follow-up call. Fallback poll every 10 blocks = 10x fewer multicalls.

### R2: PCS Swap Event ABI Mismatch
**Risk**: Medium. If we parse PCS Swap events with UNI ABI, the extra `protocolFees` fields will cause decoding to fail.
**Mitigation**: Detect by topic0 hash before decoding. Verified: different signatures produce different hashes.

### R3: WSS Connection Drops
**Risk**: High on BSC. Known issue with idle disconnections (15-30min timeout).
**Mitigation**: Block subscription acts as keepalive. Gap backfill on reconnect. Fallback polling as safety net.

### R4: Event Storm During High Activity
**Risk**: Medium. If 50 swaps happen across all pools in one block, we get 50 events simultaneously.
**Mitigation**: Per-pair debounce ensures at most 5 detections (one per pair) per block, same as current. In practice, most blocks only have 1-3 swaps across monitored pools.

### R5: Breaking Existing Block-Driven Behavior
**Risk**: Low. Event-driven is an additive layer. `EVENT_DRIVEN_ENABLED=false` falls back to exact current behavior.
**Mitigation**: Feature flag in .env. Default to `true` on the feature branch but can be toggled.

---

## Verification Criteria

1. **Unit tests pass**: EventListener parsing, dedup, gap detection
2. **tsc --noEmit**: Clean
3. **npm test**: All 121+ existing tests still pass
4. **5-min smoke test** with `EVENT_DRIVEN_ENABLED=true`:
   - Events are received and parsed (visible in logs)
   - Cache updates happen on Swap events WITHOUT multicall
   - Detection triggers only for affected pairs
   - Fallback poll still runs every 10 blocks
   - No crashes on WSS reconnection
5. **5-min smoke test** with `EVENT_DRIVEN_ENABLED=false`:
   - Identical behavior to current main branch
6. **Compare telemetry**: Event-driven vs polling detection latency

---

## Estimated RPC Impact

**Current (block polling):**
- 1 multicall per block × 192k blocks/day = **192k RPCs** for PriceFeed alone
- Plus ~10-22 QuoterV2 calls per qualified pair per block

**After (event-driven):**
- 0 RPCs for Swap events (state in event data)
- ~1 RPC per Mint/Burn event (rare — maybe 100-500/day across 10 pools)
- 1 multicall per 10 blocks = **19.2k RPCs** for fallback (10x reduction)
- QuoterV2 calls only for pairs that actually moved (estimated 60-80% reduction)

**Net reduction: ~80-90% fewer PriceFeed RPCs. Significant QuoterV2 reduction from targeted detection.**
