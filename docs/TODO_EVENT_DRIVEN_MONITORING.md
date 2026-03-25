# TODO: Event-Driven Pool Monitoring

## Current Approach

The bot currently uses **block-driven polling**: on each new block (every ~0.45s on BSC post-Fermi), a multicall batch fetches `slot0()` + `liquidity()` for all monitored pools. This is simple and reliable, but has limitations:

1. **Wasted RPC calls** — polls even when no pool state changed
2. **Latency** — detects changes only after the block is mined and the `block` event fires, not when the transaction lands
3. **No granularity** — cannot distinguish which pools changed within a block
4. **No context** — doesn't know *what* happened (swap direction, size, mint/burn range)

## Proposed: Event-Driven Monitoring

Subscribe to on-chain events emitted by V3 pools to detect state changes in real-time.

### Target Events

#### Swap (highest priority)
```solidity
event Swap(
    address indexed sender,
    address indexed recipient,
    int256 amount0,
    int256 amount1,
    uint160 sqrtPriceX96,
    uint128 liquidity,
    int24 tick
);
```
- Emitted on every swap — directly provides new `sqrtPriceX96`, `liquidity`, `tick`
- No additional RPC call needed to get updated pool state
- Swap events are the primary arbitrage trigger: a large swap on one DEX shifts price, creating spread vs the other DEX

#### Mint (medium priority)
```solidity
event Mint(
    address sender,
    address indexed owner,
    int24 indexed tickLower,
    int24 indexed tickUpper,
    uint128 amount,
    uint256 amount0,
    uint256 amount1
);
```
- Liquidity addition changes pool depth — affects optimal borrow amount and slippage
- Less urgent than Swap (liquidity changes don't directly create arbitrage opportunities)

#### Burn (medium priority)
```solidity
event Burn(
    address indexed owner,
    int24 indexed tickLower,
    int24 indexed tickUpper,
    uint128 amount,
    uint256 amount0,
    uint256 amount1
);
```
- Liquidity removal — same impact as Mint but in reverse
- Sudden large burns can increase slippage, making existing opportunities riskier

### Implementation Plan

#### Phase 1: Swap Event Listener
1. Add ethers `Contract.on("Swap", ...)` listener for each monitored pool's address
2. On Swap event, update `PoolStateCache` directly from event data (`sqrtPriceX96`, `liquidity`, `tick`)
3. Trigger detection immediately for the affected pair only (not all pairs)
4. Keep block-based polling as fallback for missed events (WebSocket drops)

#### Phase 2: Selective Refresh
1. On Swap event, only re-quote the affected pair (not full multicall)
2. Reduces QuoterV2 RPC calls significantly
3. Track event-driven vs poll-driven detection rates in telemetry

#### Phase 3: Mint/Burn Awareness
1. Subscribe to Mint/Burn events
2. Update internal liquidity model per tick range
3. Use liquidity changes to adjust optimal borrow amount in real-time

### Architecture Considerations

**WebSocket subscription limits**: BSC RPC providers may limit the number of `eth_subscribe` topics. With 10 pools, that's 10 Swap subscriptions. Check provider limits before deploying.

**Event ordering**: Multiple Swap events can arrive in a single block. Process sequentially and only trigger detection on the last event per pair per block (debounce).

**Fallback strategy**: Always keep block-based polling as a safety net. Events can be missed on WebSocket reconnection. The poll catches up within one block time.

**Log filter approach** (alternative to per-pool subscription):
```typescript
// Single subscription for all pool Swap events via eth_subscribe("logs", ...)
const swapTopic = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
wsProvider.on({ topics: [swapTopic], address: poolAddresses }, (log) => { ... });
```
This is more efficient than N individual subscriptions — one WebSocket channel covers all pools.

### Performance Impact

- **Positive**: Fewer wasted multicall RPCs, faster reaction to price changes
- **Negative**: More WebSocket messages to parse, potential for event storms during high-activity blocks
- **Net**: Should reduce end-to-end detection latency from ~450ms (one block) to <50ms (event propagation delay)

### Migration Path

1. Implement event listener alongside existing polling (dual mode)
2. Compare detection latency and opportunity counts between modes via telemetry
3. Once validated, make events primary and polling the fallback
4. Eventually reduce poll frequency from every-block to every-N-blocks
