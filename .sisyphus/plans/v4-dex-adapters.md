# Plan: V4-Style DEX Adapters (Uniswap V4 + PancakeSwap Infinity CLMM)

## Objective

Add Uniswap V4 and PancakeSwap Infinity CLMM as new arbitrage legs alongside existing Uni V3 × PCS V3. Both new DEXes use the same "V4-style" singleton architecture (PoolManager + PoolId + hooks), so a single adapter pattern covers both. This phase is **monitoring + opportunity detection only** — no new on-chain execution contract (Phase C deferred).

## Decisions Locked

| # | Decision | Choice |
|---|----------|--------|
| D1 | Scope | Both Uni V4 + PCS Infinity together |
| D2 | Architecture | Adapter pattern — V3 code untouched |
| D3 | On-chain contract | Off-chain monitoring first (C), execution contract later (B) |
| D4 | Pool discovery | Index `Initialize` events + brute-force PoolKey computation for known pairs |

---

## Current Architecture (V3 Only)

```
PoolDiscovery (factory.getPool per DEX)
    → DiscoveredPoolPair { uniswapPool: address, pancakePool: address }

PriceFeed / EventListener (pool.slot0() per address, V3 Swap topic filtering)
    → PoolStateCache { poolAddress, dex, sqrtPriceX96, tick, liquidity }

OpportunityDetector (compare PoolState across DEXes)
    → QuoterService (V3 QuoterV2 per DEX)
    → profit/loss decision
```

### V3-Specific Coupling Points (from codebase audit)

| Component | File | V3 Assumption | Adapter Impact |
|-----------|------|--------------|----------------|
| `Dex` enum | `src/config/pools.ts:1-4` | Only `UniswapV3`, `PancakeSwapV3` | Add 2 new entries |
| Constants | `src/config/constants.ts:6-19` | Only V3 factory/quoter addresses | Add V4/Infinity address blocks |
| `PoolDiscovery` | `src/feeds/PoolDiscovery.ts:9-12,83-86` | `factory.getPool(tokenA,tokenB,fee)` | New discovery adapter for singleton pattern |
| `PriceFeed` | `src/feeds/PriceFeed.ts:13-16,171-224` | `pool.slot0()` ABI on per-pool contract | New price reader for `poolManager.getSlot0(poolId)` |
| `EventListener` | `src/feeds/EventListener.ts:10-12,225-247` | Hardcoded `UNI_SWAP_TOPIC`, `PCS_SWAP_TOPIC` | Add V4/Infinity Swap topics + decoders |
| `PoolStateCache` | `src/feeds/PoolStateCache.ts:3-19` | `poolAddress` as pool identity | **No change needed** — V4/Infinity pools get a synthetic "address" (PoolId hex) |
| `QuoterService` | `src/strategy/QuoterService.ts:8-10,48-51,62-63` | V3 `quoteExactInputSingle` ABI, branches on 2 DEXes | Add V4Quoter/CLQuoter adapters |
| `OpportunityDetector` | `src/strategy/OpportunityDetector.ts` | Uses `sqrtPriceX96`, `tick`, `liquidity` from `PoolState` | **No change needed** — V4/Infinity expose same fields |
| `ExecutionEngine` | `src/execution/ExecutionEngine.ts:18-20` | Maps `Dex` → `DEX_TYPE` for on-chain call | Skip for now (off-chain only phase) |
| `FlashSwapArbitrage.sol` | `contracts/FlashSwapArbitrage.sol` | V3 CREATE2 + flash callback | Skip for now (off-chain only phase) |

### Key Insight: What DOESN'T Change

The entire pipeline from `PoolStateCache` → `OpportunityDetector` → spread/profit calculation is **DEX-agnostic** because all four DEXes use `sqrtPriceX96 + tick + liquidity`. The adapter work is purely in the "plumbing" layer that *reads* this data from the chain and *quotes* swaps.

---

## Target Architecture

```
                      ┌─────────────────────────────────────────────┐
                      │           Pool Discovery Layer              │
                      │                                             │
                      │  V3PoolDiscovery (existing)                 │
                      │    factory.getPool(tokenA, tokenB, fee)     │
                      │    → { poolAddress, dex, token0, token1 }   │
                      │                                             │
                      │  V4PoolDiscovery (new)                      │
                      │    Index Initialize events from             │
                      │    PoolManager / CLPoolManager               │
                      │    Brute-force PoolKey for known tokens     │
                      │    → { poolId, dex, token0, token1 }        │
                      └──────────────┬──────────────────────────────┘
                                     │
                                     ▼
                      ┌─────────────────────────────────────────────┐
                      │         Price Feed Layer                     │
                      │                                             │
                      │  V3 path: multicall pool.slot0() per addr   │
                      │  V4 path: multicall mgr.getSlot0(poolId)    │
                      │           per PoolManager                    │
                      │                                             │
                      │  Both → PoolStateCache (same PoolState)     │
                      └──────────────┬──────────────────────────────┘
                                     │
                                     ▼
                      ┌─────────────────────────────────────────────┐
                      │          Event Listener Layer                │
                      │                                             │
                      │  V3: Subscribe per-pool Swap events         │
                      │  V4: Subscribe PoolManager Swap events      │
                      │      filtered by PoolId (topic[1])          │
                      │                                             │
                      │  Both → PoolStateCache upsert               │
                      └──────────────┬──────────────────────────────┘
                                     │
                                     ▼
                      ┌─────────────────────────────────────────────┐
                      │       Quoter Layer                           │
                      │                                             │
                      │  V3: QuoterV2.quoteExactInputSingle(params) │
                      │  V4: V4Quoter.quoteExactInputSingle(params) │
                      │  Inf: CLQuoter.quoteExactInputSingle(params)│
                      │                                             │
                      │  All → { amountOut: bigint }                │
                      └──────────────┬──────────────────────────────┘
                                     │
                                     ▼
                      ┌─────────────────────────────────────────────┐
                      │    OpportunityDetector (UNCHANGED)           │
                      │                                             │
                      │  Compare PoolState across any DEX combos    │
                      │  Spread calculation, optimizer, profit check │
                      └─────────────────────────────────────────────┘
```

---

## Critical Design Decisions

### D5: Pool Identity — PoolId as Synthetic Address

**Problem**: V3 pools have contract addresses. V4/Infinity pools are identified by `PoolId` (bytes32 keccak256 of PoolKey). Our `PoolStaticMeta` has a `poolAddress: string` field used everywhere.

**Decision**: Use the hex-encoded PoolId AS the `poolAddress` field for V4/Infinity pools. A bytes32 hex is 66 chars (with 0x prefix) vs 42 chars for an address — both are valid string keys. This requires **zero changes** to PoolStateCache, OpportunityDetector, or any downstream consumer.

**Rationale**: The `poolAddress` field is used as:
1. A map key in `PoolStateCache` (line 21-23: `stateKey(dex, poolAddress)`) — works with any string
2. An identifier for logging/matching — works with any string
3. An on-chain call target (only in `ExecutionEngine`, which we skip this phase)

The only code that would break is code that tries to call functions on `poolAddress` as a contract — but that's in V3-specific paths (PriceFeed, EventListener) which we'll handle with branching by `Dex` type.

### D6: PoolKey Storage — Where to Keep the Full PoolKey

**Problem**: V4/Infinity quoters need the full `PoolKey` struct (currency0, currency1, fee, tickSpacing, hooks, poolManager). We can't derive this from `PoolStaticMeta` alone.

**Decision**: Add a new `V4PoolRegistry` class that maps `PoolId → PoolKey`. The registry is populated during pool discovery and consulted by the quoter adapter.

```typescript
// src/feeds/V4PoolRegistry.ts
interface PoolKeyData {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  poolManager: string;
}

class V4PoolRegistry {
  private keys = new Map<string, PoolKeyData>(); // poolId → PoolKey
  register(poolId: string, key: PoolKeyData): void;
  getKey(poolId: string): PoolKeyData | undefined;
}
```

### D7: Arb Pair Matching — Cross-DEX Pair Formation

**Problem**: Currently `DiscoveredPoolPair` holds exactly one `uniswapPool` and one `pancakePool`. With 4 DEXes, a token pair might exist on 2, 3, or all 4, creating multiple arb opportunities.

**Decision**: Generalize `DiscoveredPoolPair` to hold an array of pools per pair:

```typescript
interface DiscoveredPool {
  dex: Dex;
  poolIdentifier: string;  // address for V3, poolId for V4/Infinity
  fee: number;
}

interface DiscoveredPairGroup {
  token0: string;
  token1: string;
  pools: DiscoveredPool[];  // All pools for this token pair across all DEXes
}
```

The `OpportunityDetector` already compares pools via `PoolStateCache.getByPair()` which returns all pools for a token pair regardless of DEX. The main change is in pool discovery output format and how `PriceFeed`/`EventListener` register which pools to monitor.

### D8: Event Subscription Strategy for Singletons

**Problem**: V3 subscribes to events filtered by pool contract addresses. V4/Infinity emit all Swap events from a single PoolManager contract, indexed by `PoolId` in topic[1].

**Decision**: For V4/Infinity, subscribe to the PoolManager address with the Swap topic. Filter incoming events client-side by checking `topic[1]` (PoolId) against our watched pool set. This is efficient because:
- Only 1 subscription per PoolManager (vs 1 per pool in V3)
- BSC V4/Infinity Swap volume is manageable (~200-800 pairs total per DEX)
- Client-side PoolId filtering is a Set lookup (O(1))

### D9: Quoter Adapter Strategy

**Problem**: V3 quoter takes `(tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96)`. V4/Infinity quoters take `PoolKey` struct + `zeroForOne` + `exactAmount`.

**Decision**: Extend `QuoterService` with an internal `getQuoter(dex)` method that returns the right contract + encoder. The `QuoteRequest` interface already has `dex`, `tokenIn`, `tokenOut`, `fee`, `amountIn` — sufficient to construct any quoter call. For V4/Infinity, the quoter adapter will look up the `PoolKey` from `V4PoolRegistry`.

```typescript
// Inside QuoterService:
private async quoteV4(req: QuoteRequest): Promise<QuoteResult> {
  const poolKey = this.v4Registry.getKey(req.poolId);
  const zeroForOne = req.tokenIn.toLowerCase() < req.tokenOut.toLowerCase();
  const result = await this.v4Quoter.quoteExactInputSingle.staticCall({
    poolKey,
    zeroForOne,
    exactAmount: req.amountIn,
    hookData: "0x",
  });
  return { amountOut: result.amountOut };
}
```

### D10: Hooks Safety Filter

**Problem**: V4/Infinity pools can have hooks that modify swap behavior (dynamic fees, token deltas, reverts). This makes quoting unreliable for hooked pools.

**Decision**: During pool discovery, check the `hooks` field of each PoolKey. **Initially whitelist only `hooks == address(0)` (no hooks) pools.** This eliminates unpredictable behavior. Later, we can build a hooks safety analyzer that categorizes known hook contracts.

---

## Implementation Phases

### Phase 1: Config & Types (Est: 1 hour)

**Files to modify:**
- `src/config/pools.ts` — Add `Dex.UniswapV4` and `Dex.PancakeSwapInfinity` to enum
- `src/config/constants.ts` — Add `UNISWAP_V4` and `PANCAKESWAP_INFINITY` address blocks

**New constants:**
```typescript
export const UNISWAP_V4 = {
  poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
  stateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
  quoter: "0x9f75dd27d6664c475b90e105573e550ff69437b0",
} as const;

export const PANCAKESWAP_INFINITY = {
  vault: "0x238a358808379702088667322f80aC48bAd5e6c4",
  clPoolManager: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
  clQuoter: "0xd0737C9762912dD34c3271197E362Aa736Df0926",
} as const;
```

**Verification**: `npx tsc --noEmit` passes.

---

### Phase 2: V4PoolRegistry (Est: 2-3 hours)

**New file:** `src/feeds/V4PoolRegistry.ts`

**Responsibilities:**
1. Store `PoolId → PoolKeyData` mapping for all watched V4/Infinity pools
2. Compute `PoolId` from `PoolKey` via `keccak256(abi.encode(poolKey))`
3. Persist discovered pools to `data/v4-pool-registry.json` for fast startup

**PoolKey encoding (must match on-chain exactly):**

Uniswap V4 PoolKey:
```solidity
struct PoolKey {
  Currency currency0;     // address
  Currency currency1;     // address
  uint24 fee;
  int24 tickSpacing;
  IHooks hooks;           // address
}
// PoolId = keccak256(abi.encode(poolKey)) — 5 slots × 32 bytes
```

PCS Infinity PoolKey:
```solidity
struct PoolKey {
  Currency currency0;     // address
  Currency currency1;     // address
  IHooks hooks;           // address
  IPoolManager poolManager; // address
  uint24 fee;
  bytes32 parameters;     // contains tickSpacing + hook flags
}
// PoolId = keccak256(abi.encode(poolKey)) — 6 slots
```

⚠️ **CRITICAL**: The PoolKey struct layout is DIFFERENT between Uni V4 and PCS Infinity. The keccak256 encoding must match each protocol's exact layout. This requires two separate encoding functions.

**Interface:**
```typescript
export interface V4PoolKeyData {
  dex: Dex;  // UniswapV4 or PancakeSwapInfinity
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  // PCS Infinity-specific:
  poolManager?: string;
  parameters?: string;  // bytes32 hex
}

export class V4PoolRegistry {
  register(poolId: string, key: V4PoolKeyData): void;
  getKey(poolId: string): V4PoolKeyData | undefined;
  getAllByDex(dex: Dex): Array<{ poolId: string; key: V4PoolKeyData }>;
  computePoolId(key: V4PoolKeyData): string;
  save(filePath: string): Promise<void>;
  load(filePath: string): Promise<void>;
}
```

**Verification**: Unit test — encode known PoolKey, verify PoolId matches on-chain value via `stateView.getSlot0(poolId)` returning non-zero sqrtPriceX96.

---

### Phase 3: Pool Discovery Adapter (Est: 4-5 hours)

**Modify:** `src/feeds/PoolDiscovery.ts`

**New method:** `discoverV4Pools()` — parallel to existing `discover()`

**Two-pronged approach:**

**A) Brute-force for known token pairs (fast, targeted):**
For every token pair in our 6-token registry × common fee/tickSpacing combos:
1. Construct `PoolKey` with `hooks = address(0)` (no hooks)
2. Compute `PoolId`
3. Call `poolManager.getSlot0(poolId)` or `stateView.getSlot0(poolId)`
4. If `sqrtPriceX96 > 0` → pool exists → register in `V4PoolRegistry`

Common tickSpacing values to try: `[1, 10, 60, 200]` (V4), `[1, 10, 50, 100]` (Infinity)
Common fee values: `[100, 500, 3000, 10000]` (V4), `[100, 500, 2500, 10000]` (Infinity)

This gives us ~6C2 × 4 fee × 4 tickSpacing × 2 DEXes = 15 × 4 × 4 × 2 = **960 combinations** — feasible in a single multicall batch.

**B) Index `Initialize` events (comprehensive, slower):**
1. Query `PoolManager.Initialize` / `CLPoolManager.Initialize` events from genesis
2. Filter for events involving tokens in our watchlist
3. Extract PoolKey data from event parameters
4. Register all matching pools

**Initialize event signatures:**
```solidity
// Uniswap V4:
event Initialize(
  PoolId indexed id,
  Currency indexed currency0,
  Currency indexed currency1,
  uint24 fee, int24 tickSpacing, IHooks hooks,
  uint160 sqrtPriceX96, int24 tick
);

// PCS Infinity:
event Initialize(
  PoolId indexed id,
  Currency indexed currency0,
  Currency indexed currency1,
  uint24 fee, int24 tick,
  // (may differ — verify from source)
);
```

**Output:**
```typescript
interface V4DiscoveredPool {
  dex: Dex;
  poolId: string;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  sqrtPriceX96: bigint;
}
```

**Verification**: Run discovery script, compare pool count against CoinGecko numbers (Uni V4: 237 coins / 802 pairs, PCS Infinity: 151 coins / 408 pairs).

---

### Phase 4: PriceFeed Adapter (Est: 2-3 hours)

**Modify:** `src/feeds/PriceFeed.ts`

**Current**: Builds multicall of `pool.slot0()` targeting per-pool contract addresses.

**Change**: Add a second multicall batch for V4/Infinity pools that targets:
- Uni V4: `stateView.getSlot0(poolId)` at `0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4`
- PCS Infinity: `clPoolManager.getSlot0(poolId)` at `0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b`

**ABI fragments (new):**
```typescript
const V4_STATE_ABI = [
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) external view returns (uint128)",
];
```

**Implementation approach:**
1. In `buildCalls()`, partition monitored pools into V3 pools and V4 pools by `Dex` type
2. V3 pools → existing multicall to per-pool `slot0()` + `liquidity()`
3. V4 pools → multicall to singleton `getSlot0(poolId)` + `getLiquidity(poolId)`
4. Both → decode into same `PoolDynamicState { sqrtPriceX96, tick, liquidity }`

⚠️ **Note**: V4 `getSlot0` returns `(sqrtPriceX96, tick, protocolFee, lpFee)` — we only need the first two fields plus a separate `getLiquidity()` call. Same data as V3, different call path.

**Verification**: Read price from a known V4/Infinity pool, compare against CoinGecko/DexScreener price.

---

### Phase 5: EventListener Adapter (Est: 2-3 hours)

**Modify:** `src/feeds/EventListener.ts`

**New Swap event topic hashes (to compute and verify):**

```typescript
// Uniswap V4 PoolManager Swap:
// Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
export const UNI_V4_SWAP_TOPIC = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

// PCS Infinity CLPoolManager Swap:
// Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee, uint16 protocolFee)
export const PCS_INF_SWAP_TOPIC = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24,uint16)");
```

**Subscription changes:**
- Add `ALL_TOPICS` entries for V4/Infinity Swap topics
- Add subscription addresses: V4 PoolManager + PCS Infinity CLPoolManager
- For V3: filter by per-pool addresses (existing)
- For V4/Infinity: filter by PoolManager address, then check `topic[1]` (PoolId) against watched set

**Decoder logic:**
```typescript
if (topic0 === UNI_V4_SWAP_TOPIC || topic0 === PCS_INF_SWAP_TOPIC) {
  const poolId = log.topics[1];  // bytes32 indexed
  if (!this.watchedV4Pools.has(poolId)) return;  // Skip unwatched pools
  // Decode: int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, ...
  // V4 uses int128 instead of int256, but BigInt handles both
}
```

**Key difference from V3 events**: V4/Infinity Swap events include `fee` as an explicit field — useful for dynamic-fee pools.

**Verification**: Subscribe to V4 PoolManager on BSC, observe Swap events flowing for known active pools.

---

### Phase 6: QuoterService Adapter (Est: 2-3 hours)

**Modify:** `src/strategy/QuoterService.ts`

**New quoter ABIs:**
```typescript
// Uniswap V4 Quoter
const V4_QUOTER_ABI = [
  "function quoteExactInputSingle((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, uint128 amountIn, bool zeroForOne, bytes hookData) params) external returns (uint256 amountOut, uint256 gasEstimate)",
];

// PCS Infinity CLQuoter
const CL_QUOTER_ABI = [
  "function quoteExactInputSingle((... PoolKey ..., bool zeroForOne, uint128 exactAmount, bytes hookData) params) external returns (uint256 amountOut, uint256 gasEstimate)",
];
```

⚠️ **NOTE**: Exact ABI for V4Quoter and CLQuoter must be verified from deployed bytecode on BSCScan. The struct layouts in the quoter params include `PoolKey` fields inline — these are not simple tuple params.

**Implementation:**
1. Add `v4Quoter` and `infQuoter` contract instances in constructor
2. Extend `quoteExactInputSingle()` to branch on `Dex.UniswapV4` / `Dex.PancakeSwapInfinity`
3. For V4/Infinity quotes, look up `PoolKey` from `V4PoolRegistry` and construct the struct param
4. Parse result — both return `(uint256 amountOut, uint256 gasEstimate)`

**QuoteRequest extension:**
```typescript
export interface QuoteRequest {
  dex: Dex;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: bigint;
  sqrtPriceLimitX96?: bigint;
  poolId?: string;  // NEW — for V4/Infinity pool identification
}
```

**Verification**: Quote WBNB→USDT on V4 and Infinity, compare amountOut with V3 quote for same amount.

---

### Phase 7: Pool Scanner Script (Est: 2 hours)

**New file:** `scripts/scan-v4-pools.ts`

Reuses token list from `scan-candidate-pools.ts` (51 tokens) and scans:
1. All token pair × fee × tickSpacing combos on Uni V4 PoolManager
2. All token pair × fee × tickSpacing combos on PCS Infinity CLPoolManager
3. Cross-reference with existing V3 viable pools to identify overlapping pairs

**Output**: JSON summary of V4/Infinity pools with:
- Token pair, fee, tickSpacing
- sqrtPriceX96 (current price)
- Which V3 pools overlap (arb candidates)

---

### Phase 8: Integration Test & Dry Run (Est: 2-3 hours)

1. Run full bot with `DRY_RUN=true` including V4/Infinity pools
2. Verify:
   - Pool discovery finds V4/Infinity pools correctly
   - PriceFeed reads sqrtPriceX96 from singleton contracts
   - EventListener receives and parses V4/Infinity Swap events
   - QuoterService returns valid quotes from V4/Infinity quoters
   - OpportunityDetector detects cross-DEX spreads involving V4/Infinity
3. Compare spread sizes: V3↔V3 vs V3↔V4 vs V3↔Infinity vs V4↔Infinity

---

## Deferred (Future Phases)

### Phase C→B: Execution Contract

**When**: After monitoring confirms profitable opportunities exist.

**What**: Build `V4FlashArbitrage.sol` that uses:
- Uni V4: `poolManager.unlock()` → `unlockCallback()` → swap + settle
- PCS Infinity: `vault.lock()` → `lockCallback()` → `vault.take()` + swap + `vault.settle()`

**Key benefit**: PCS Infinity flash loans are **FREE** (no fee if net settles to zero).

### Hooks Analyzer

Catalog known hook contracts on BSC, classify as safe/unsafe for arb routing.

### Dynamic Fee Tracking

For pools with `fee == 0x800000` (dynamic), track actual fees from Swap events to improve spread threshold calculation.

---

## Files Changed (Summary)

| File | Action | Phase |
|------|--------|-------|
| `src/config/pools.ts` | Modify — add Dex entries | 1 |
| `src/config/constants.ts` | Modify — add V4/Infinity addresses | 1 |
| `src/feeds/V4PoolRegistry.ts` | **NEW** — PoolId↔PoolKey mapping | 2 |
| `src/feeds/PoolDiscovery.ts` | Modify — add V4 discovery methods | 3 |
| `src/feeds/PriceFeed.ts` | Modify — add singleton getSlot0 calls | 4 |
| `src/feeds/EventListener.ts` | Modify — add V4/Infinity Swap topics + decoders | 5 |
| `src/strategy/QuoterService.ts` | Modify — add V4/Infinity quoter adapters | 6 |
| `scripts/scan-v4-pools.ts` | **NEW** — V4/Infinity pool scanner | 7 |
| `src/index.ts` | Modify — wire V4PoolRegistry, expanded discovery | 8 |

**Files NOT changed:**
- `src/feeds/PoolStateCache.ts` — PoolState type unchanged
- `src/strategy/OpportunityDetector.ts` — consumes PoolState generically
- `src/strategy/IOptimizer.ts` / `AdaptiveGridOptimizer.ts` — unchanged
- `src/execution/ExecutionEngine.ts` — skip (off-chain only phase)
- `contracts/FlashSwapArbitrage.sol` — skip (off-chain only phase)

---

## Estimated Total Effort

| Phase | Description | Hours |
|-------|-------------|-------|
| 1 | Config & Types | 1 |
| 2 | V4PoolRegistry | 2-3 |
| 3 | Pool Discovery Adapter | 4-5 |
| 4 | PriceFeed Adapter | 2-3 |
| 5 | EventListener Adapter | 2-3 |
| 6 | QuoterService Adapter | 2-3 |
| 7 | Pool Scanner Script | 2 |
| 8 | Integration Test & Dry Run | 2-3 |
| **Total** | | **~17-23 hours** |

---

## Open Questions (To Verify During Implementation)

1. **V4Quoter exact ABI**: Must decode from BSCScan verified source at `0x9f75dd27d6664c475b90e105573e550ff69437b0`. The struct layout for `QuoteExactSingleParams` includes PoolKey fields.

2. **CLQuoter exact ABI**: Must decode from BSCScan at `0xd0737C9762912dD34c3271197E362Aa736Df0926`. Uses `PoolKey` struct from PCS Infinity (different from Uni V4).

3. **PCS Infinity Initialize event**: Need to verify the exact event signature from `CLPoolManager` source to properly decode event logs.

4. **Common tickSpacing values on BSC**: Need to discover what tickSpacing values are actually used in deployed pools (affects brute-force scan completeness).

5. **V4 hooks prevalence on BSC**: What percentage of V4/Infinity pools have non-zero hooks? If most do, our "no hooks" filter might be too restrictive.

6. **Multicall compatibility**: Can we multicall to V4 PoolManager's `getSlot0(poolId)` the same way we multicall to V3 pools? (Should work since multicall is target-agnostic.)
