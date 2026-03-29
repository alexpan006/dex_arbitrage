# Changelog

All notable project changes are tracked here.

## 2026-03-29

### V4 DEX Adapter Integration — Uniswap V4 + PancakeSwap Infinity CLMM

Expands the bot from 2-DEX (Uniswap V3 × PancakeSwap V3) to 4-DEX by adding Uniswap V4 and PancakeSwap Infinity CLMM as new arbitrage legs. Uses the adapter pattern — all V3 code remains untouched.

#### Phase 1: Config & Types
- Added `Dex.UniswapV4` and `Dex.PancakeSwapInfinity` to the `Dex` enum in `src/config/pools.ts`
- Added `isV4StyleDex()` helper for V4/Infinity branching
- Added `UNISWAP_V4` and `PANCAKESWAP_INFINITY` address constants (PoolManager, Quoter, StateView) in `src/config/constants.ts`
- Updated `ExecutionEngine.ts` DEX_TYPE map with placeholder entries for new DEXes

#### Phase 2: V4PoolRegistry
- Created `src/feeds/V4PoolRegistry.ts` — PoolId↔PoolKey mapping with JSON persistence
- `computeUniV4PoolId()` and `computePcsInfinityPoolId()` — keccak256 PoolKey hashing (5-slot vs 6-slot structs)
- `encodePcsInfinityParameters()` / `decodePcsInfinityTickSpacing()` — PCS Infinity bytes32 parameter encoding
- Save/load to `data/v4-pool-registry.json` for persistent pool discovery caching

#### Phase 3: Pool Discovery Adapter
- Rewrote `src/feeds/PoolDiscovery.ts` — preserved V3 `discover()`, added `discoverV4Pools(registry)` brute-force method
- `discoverAll(registry)` combines V3+V4 into `DiscoveredPairGroup[]` — groups all pools for the same token pair regardless of DEX/fee
- Added try/catch for V3 `getPool()` reverts on invalid token/fee combos

#### Phase 4: PriceFeed Adapter
- Rewrote `src/feeds/PriceFeed.ts` — `buildCalls()` partitions V3 vs V4 pools
- V4 pools read via singleton `getSlot0(poolId)` + `getLiquidity(poolId)` on PoolManager
- Added `buildMonitoredPoolsFromGroups()` to convert `DiscoveredPairGroup[]` into `MonitoredPool[]`
- Added **parallel chunked multicall** (`MULTICALL_CHUNK_SIZE=40`) to handle large pool counts without payload overflow

#### Phase 5: EventListener Adapter
- Rewrote `src/feeds/EventListener.ts` — added V4 Swap event topics for both Uniswap V4 and PCS Infinity
- Dual WSS subscription strategy: V3 pools subscribe by address, V4 pools subscribe by PoolManager + filter `topic[1]` as PoolId
- V4 Swap events use `int128` types (vs V3's `int256`)

#### Phase 6: QuoterService Adapter
- Rewrote `src/strategy/QuoterService.ts` — V4Quoter + CLQuoter contract instances
- Branches on DEX type: V3 uses existing QuoterV2, V4 uses `quoteExactInputSingle` with PoolKey struct
- Uniswap V4 PoolKey: 5-slot `(currency0, currency1, fee, tickSpacing, hooks)`
- PCS Infinity PoolKey: 6-slot `(currency0, currency1, hooks, poolManager, fee, parameters)`
- Uses `staticCall` for revert-based quoting

#### Phase 6b: OpportunityDetector Generalization
- Rewrote `src/strategy/OpportunityDetector.ts` for multi-DEX pairwise comparison
- `pairKey()` no longer includes fee — same token pair across different DEXes/fees are compared
- Nested-loop pairwise: `for a, for b>a, skip if same DEX` (replaces hardcoded uni/pcs matching)
- Updated `TelemetryRecord` — `uniPrice`/`pcsPrice` → `priceA`/`priceB`, added `dexA`/`dexB` fields
- V4 pools pass `poolId` in QuoteRequest for correct PoolKey-based quoting

#### Phase 7: V4 Pool Scanner Script
- Created `scripts/scan-v4-pools.ts` — standalone script to discover V4/Infinity pools via brute-force PoolKey enumeration
- Scans tickSpacing×fee combinations for configured token pairs
- Persists discovered pools to `data/v4-pool-registry.json`

#### Phase 8: Integration Wiring
- Updated `src/index.ts` — V4PoolRegistry, `discoverAll()`, `buildMonitoredPoolsFromGroups()`
- Full bot startup flow: load registry → discover V3+V4 → build groups → monitor all pools

#### Bug Fixes During Smoke Test
- **Multicall payload overflow**: 68+ pools (136 calls) exceeded single-batch multicall3 limit → added parallel chunked multicall with `MULTICALL_CHUNK_SIZE=40`, failed chunks gracefully return empty data
- **V3 getPool reverts**: Some token/fee combos revert on factory → added `.catch(() => ZERO_ADDRESS)` fallback

#### 5-Minute Dry-Run Smoke Test Results
- **70 monitored pools**: 19 V3 + 31 Uni V4 + 1 PCS Infinity (across 13 pair groups)
- **29,992 telemetry records**: 18,929 spread_below_min + 11,063 optimizer_no_candidate
- **DEX coverage**: 9 unique cross-DEX combo types detected
- **V4 prices verified correct**: USDT/WBNB ≈ 0.00164 (610 USDT/BNB), ETH ≈ $1,997
- **2 anomalous "ghost pools"** identified (UniswapV4:10000 USDT/WBNB, PCSInfinity:500 ETH/USDT) — price=3.4e+38, liquidity=0. Optimizer correctly rejected with `optimizer_no_candidate`
- **Max meaningful spread**: 620 bps (ETH/USDC UniswapV4:500 vs UniswapV3:100) — pool has zero liquidity, so no executable arb
- **No profitable opportunities** found in 5-min window — expected for short monitoring duration

#### Known Issues (Deferred)
- Ghost pools with `price=3.4e+38` should be filtered by minimum liquidity or price sanity check at discovery time
- All `optimizer_no_candidate` rejections were due to `liquidityCap: "0"` — the pools exist on-chain but have no funded positions
- Execution contract for V4/Infinity flash accounting deferred until profitable opportunities are confirmed

#### Verification
- `npx tsc --noEmit` — clean (0 errors)
- `npm test` — **139 passing, 0 failing, 1 pending**
- 5-minute dry-run smoke test — clean startup, full runtime, clean shutdown

---

## 2026-03-28

### Pluggable Optimizer Interface + Adaptive Grid

#### Architecture
- **Created `src/strategy/IOptimizer.ts`** — pluggable interface (`IOptimizer`, `OptimizerResult`, `OptimizerMetrics`, `ProfitPoint`, `OptimizerFactory`) allowing different optimization strategies to be swapped without rewriting OpportunityDetector or other components
- **Refactored `src/strategy/OpportunityDetector.ts`** — depends on `IOptimizer` interface via `OptimizerFactory` pattern. Default factory creates `AdaptiveGridOptimizer`. Removed `coarseRatiosBps`, `refineIterations`, `maxQuoteEvaluations` from detector options
- **Refactored `src/strategy/HybridAmountOptimizer.ts`** — now implements `IOptimizer`. Removed parabolic interpolation and golden section refinement. `HybridOptimizerMetrics`/`HybridOptimizerResult` are type aliases to shared interface types

#### New Optimizer
- **Created `src/strategy/AdaptiveGridOptimizer.ts`** — log-scale grid optimizer with default ratios `[10, 50, 100, 300, 700, 1500, 3500, 6500, 9000]` bps. For $100K max borrow: $100, $500, $1K, $3K, $7K, $15K, $35K, $65K, $90K. Covers small trade amounts ($50-$500) that the old linear grid (15%, 35%, 55%, 75%, 90%) completely missed
- This is the new default optimizer used by `OpportunityDetector`

#### Removed Features
- Parabolic interpolation (1 API call, marginal improvement)
- Golden section refinement (2-5 API calls, unnecessary precision)
- Both layers never triggered in production because all coarse grid points showed negative profit due to thin pool liquidity

#### Metrics Cleanup
- Removed `optimizerParabolicAcceptedCount` from `DetectorRunMetrics`
- Removed `optimizerParabolicAcceptedRate` from `RollingDetectorSummary`
- Removed parabolic logging from `src/index.ts` and monitoring pipeline
- Renamed `coarsePointCount` → `gridPointCount` in `OptimizerMetrics`

#### Tests
- Rewrote `test/unit/HybridAmountOptimizer.test.ts` — removed parabolic/golden section tests, updated to match new API
- Created `test/unit/AdaptiveGridOptimizer.test.ts` — 10 tests covering grid sweep, log-scale coverage, null handling, budget exhaustion, deduplication, custom grids, batch evaluator
- Updated `test/unit/RollingDetectorMetrics.test.ts`, `test/unit/DiscordNotifier.test.ts`, `test/integration/fullCycle.test.ts`

#### Verification
- `npx tsc --noEmit` — clean (0 errors)
- `npm test` — **139 passing, 0 failing, 1 pending**

## 2026-03-27

### Fix: Timeout Hang Bug — WSS Death Recovery

#### Bug Fix
- **Root cause**: After 6h34m of stable running, a single RPC timeout killed the WSS connection silently. With no independent recovery mechanism, the bot went permanently silent — no new blocks, no events, no detections.
- **Fixed `src/index.ts`** — three-layer resilience:
  - Added `withTimeout()` wrapper (5s) on `fallbackProvider.getBlockNumber()` inside `triggerDetection` — prevents infinite hangs on RPC calls
  - Added safety-net HTTP poll (15s interval) that fires **independently of WSS** — if no detection runs for 15s, it fetches the latest block via HTTP, refreshes the price feed, and triggers detection. Logs WSS health diagnostics on trigger.
  - Tracks `lastDetectionAtMs` in `runDetection()` for safety-net gating
  - Added `clearInterval(safetyPollTimer)` to shutdown handler
- **Fixed `src/feeds/PriceFeed.ts`** — WSS block health tracking:
  - Added `lastBlockReceivedAtMs` field, updated on every `"block"` event
  - Added `getSecondsSinceLastBlock()` public method for diagnostics
- **Fixed `src/feeds/EventListener.ts`** — WSS event health tracking:
  - Added `lastEventAtMs` field, updated on every log event received
  - Added `getSecondsSinceLastEvent()` public method for diagnostics

#### Verification Performed
- `npx tsc --noEmit` passed
- `npm test` passed (133 passing, 0 failing, 1 pending)

### Dynamic Per-Pair Spread Threshold

#### Enhancement
- **Modified `src/strategy/OpportunityDetector.ts`** — replaced flat `minSpreadBps: 2` with dynamic floor per pair:
  - Formula: `minSpreadBps = (uni.fee + pcs.fee) / 100 + SPREAD_DIFF_BPS`
  - Both swap legs charge their respective pool fee, so the floor accounts for total fee cost
  - V3 fee tiers use identical `uint24` encoding on both DEXes (fee=500 = 5 bps)
- **Modified `src/config/constants.ts`** — added `spreadDiffBps` to STRATEGY config (env: `SPREAD_DIFF_BPS`, default: `1`)
- **Updated `.env.example` and `.env`** — added `SPREAD_DIFF_BPS=1`
- **Updated `scripts/run-fork-bot.ts` and `test/integration/fullCycle.test.ts`** — renamed option to match

## 2026-03-26

### Fix: QuoterV2 ABI — Remove always-reverting Variant A

#### Bug Fix
- **Fixed `src/strategy/QuoterService.ts`** — eliminated Variant A ABI (`0xb3b11b7e`) that always reverts on BSC:
  - Both Uniswap V3 and PancakeSwap V3 QuoterV2 only support Variant B struct layout: `(tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96)` → selector `0xc6a5026a`
  - Variant A struct layout `(tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96)` → selector `0xb3b11b7e` always reverts with empty data (`0x`) on both DEXes
  - Removed try/catch fallback pattern — direct single call now
  - Reduced from 4 Contract instances to 2
  - **Impact**: Halves PCS quote RPC calls (~100 detections/min × 1 wasted call each = ~100 fewer RPC calls/min)
  - Discovered via Alchemy dashboard error analysis showing `execution reverted` on Variant A selector

#### Verification Performed
- `npx tsc --noEmit` passed
- `npm test` passed (133 passing, 0 failing, 1 pending)
- Live `staticCall` verified Variant B works for both DEXes (100 USDT and 15,000 USDT quotes)

## 2026-03-25

### OPT-5: Event-Driven Pool Monitoring

#### New Features
- **Created `src/feeds/EventListener.ts`** — WSS log subscription for real-time pool state updates:
  - Single `eth_subscribe("logs")` covering all monitored pools with OR-matched topic0 array
  - Handles both Uniswap V3 and PancakeSwap V3 Swap events (different ABI signatures, different topic0 hashes)
  - Decodes first 5 data fields for both DEXs — PCS has 7 fields but first 5 are identical layout
  - Swap events carry full pool state (sqrtPriceX96, tick, liquidity) — zero follow-up RPC needed
  - Mint/Burn events trigger single-pool Multicall3 (slot0 + liquidity) for fresh state
  - LRU dedup cache (configurable, default 5000 entries) by `txHash:logIndex` for reorg protection
  - Gap backfill via `eth_getLogs` when `lastProcessedBlock` falls behind
  - `parseLog()` exposed for unit testing without WSS connection

- **Modified `src/feeds/PriceFeed.ts`** — added event-driven support:
  - `updateSinglePool(poolAddress, dynamic)` — update cache for one pool from event data
  - `fallbackPollBlocks` option — reduce multicall frequency from every block to every N blocks
  - Block counter in `start()` handler — only calls `refresh()` when counter reaches threshold
  - Backward compatible — `fallbackPollBlocks=1` preserves original every-block behavior

- **Modified `src/feeds/PoolStateCache.ts`** — added `getByAddress()` for pool lookup by address

- **Refactored `src/index.ts`** — per-pair event-driven detection:
  - Extracted detection+execution logic into reusable `runDetection()` function
  - `triggerDetection()` wrapper handles concurrency lock and rerun-after-current logic
  - Per-pair debounce (configurable, default 50ms) — multiple Swap events in same block trigger only one detection
  - EventListener wired with onSwap callback (zero RPC → cache update → pair detection)
  - EventListener wired with onLiquidityChange callback (1 RPC → cache update → pair detection)
  - Fallback poll via `feed.onUpdate` still runs every N blocks (safety net)
  - Feature flag: `EVENT_DRIVEN_ENABLED=false` falls back to exact previous behavior
  - Graceful EventListener shutdown on SIGINT/SIGTERM

- **Added `EVENT_DRIVEN` config block to `src/config/constants.ts`**:
  - `EVENT_DRIVEN_ENABLED` (default: `true`)
  - `FALLBACK_POLL_BLOCKS` (default: `10`)
  - `EVENT_DEBOUNCE_MS` (default: `50`)
  - `EVENT_DEDUP_CACHE_SIZE` (default: `5000`)

- **Updated `.env.example`** with event-driven configuration variables

#### Tests
- **Created `test/unit/EventListener.test.ts`** — 12 tests:
  - UNI Swap event parsing (full decode verification)
  - PCS Swap event parsing (7-field data, first 5 used)
  - Mint event parsing
  - Burn event parsing
  - Unknown pool address returns null
  - Unknown topic0 returns null
  - Dedup cache starts empty
  - UNI and PCS Swap topics are different
  - All topics are valid hex strings
  - Case-insensitive pool address matching
  - Backfill disabled returns 0
  - Backfill fromBlock > toBlock returns 0

#### Verification Performed
- `npx tsc --noEmit` passed
- `npm test` passed (133 passing, 0 failing, 1 pending)

## 2026-03-20

### Telemetry System & Persistent Data Storage

#### New Features
- **Implemented `src/monitoring/TelemetryWriter.ts`** — async buffered JSONL writer for structured telemetry:
  - Per-pair records: spread (bps), prices, quote amounts, expected profit, reject reasons
  - Per-block summary records: pairs scanned, spreads found, opportunities, quote stats, duration
  - Async buffered writes (configurable buffer size, default 100 records)
  - Periodic flush timer (configurable, default 5s) — unref'd so it doesn't block process exit
  - File rotation when size exceeds threshold (configurable, default 50MB)
  - Separate JSONL files for pair-level (`pairs_*.jsonl`) and block-level (`blocks_*.jsonl`) data
  - All I/O errors swallowed — telemetry never crashes the bot
  - Enabled/disabled via `TELEMETRY_ENABLED` env var

- **Integrated telemetry into `OpportunityDetector.detect()`**:
  - Now accepts optional `blockNumber` parameter for telemetry context
  - Emits `TelemetryRecord` for every pair in every detection cycle
  - Records reject reason for each pair: `spread_below_min`, `optimizer_no_candidate`, `profit_below_min`, `accepted`
  - Records optimizer output when available: borrow amount, first/second leg output, expected profit
  - Emits `BlockSummaryRecord` at end of each detection cycle
  - Zero performance impact on hot path (buffer push only)

- **Wired telemetry into main loop (`src/index.ts`)**:
  - `TelemetryWriter` initialized from env config, started before feed
  - Passed to `OpportunityDetector` via constructor
  - Graceful shutdown flushes remaining telemetry before exit

- **Persistent local file storage**:
  - Data written to `data/telemetry/` directory (configurable via `TELEMETRY_DATA_DIR`)
  - JSONL format for easy downstream processing (grep, jq, pandas)
  - `data/` added to `.gitignore`

- **Added telemetry configuration to `.env` and `.env.example`**:
  - `TELEMETRY_ENABLED`, `TELEMETRY_DATA_DIR`, `TELEMETRY_BUFFER_SIZE`
  - `TELEMETRY_FLUSH_INTERVAL_MS`, `TELEMETRY_MAX_FILE_SIZE_MB`

- **Added `TELEMETRY` config block to `src/config/constants.ts`**

#### Documentation
- **Created `docs/TODO_EVENT_DRIVEN_MONITORING.md`**:
  - Documents current block-polling approach and its limitations
  - Proposes event-driven monitoring via Swap/Mint/Burn event subscriptions
  - Includes target event signatures, implementation phases, architecture considerations
  - Outlines migration path: dual-mode → event-primary → reduce poll frequency

## 2026-03-15

### Forknet Price Divergence & Bug Fixes

#### Bug Fixes
- **Fixed buy/sell pool inversion in `OpportunityDetector.ts`**:
  - `buyPool` was assigned to the lower-price pool instead of the higher-price pool
  - With `sqrtPriceX96ToPriceFloat()` returning `token1/token0`, higher price = more token1 per token0 = where to buy token1
  - The inverted logic caused the optimizer to always find negative profit even with large spreads
  - Fix: swapped the ternary assignments so `buyPool = higher price pool`, `sellPool = lower price pool`
- **Fixed missing `from` field in `ExecutionEngine.ts` gas estimation**:
  - `estimateGas()` was called without `from` in the tx request
  - On Anvil fork, this defaulted to the zero address, causing `NOT_OWNER` revert from the `onlyOwner` modifier
  - Fix: added `from: this.wallet.address` to the transaction request

#### New Features
- **Created `scripts/create-fork-divergence.ts`** — artificial price divergence via slot0 storage manipulation:
  - Uses `anvil_setStorageAt` to directly modify pool's slot0 storage word
  - `findSlot0StorageIndex()` scans storage slots 0-10, matching sqrtPriceX96 in low 160 bits
  - `repackSlot0()` replaces both sqrtPriceX96 AND tick while preserving other packed fields
  - `sqrtPriceX96ToTick()` computes correct tick from new sqrtPriceX96
  - `encodeInt24()` handles two's complement for negative ticks
  - Divergence creation is instant (< 1 second) — no RPC timeouts
- **Enhanced `scripts/run-fork-bot.ts`** for divergence testing:
  - Added `FORK_CREATE_DIVERGENCE` and `FORK_DIVERGENCE_BPS` env vars
  - Targets fee≥500 pool pairs for divergence (avoids tick spacing issues)
  - Reduced borrow amounts to 100 USDT max with finer coarse ratios

#### Cleanup
- Removed temporary debug logging from `OpportunityDetector.ts`
- Deleted temporary `scripts/debug-quote.ts`

#### Forknet E2E Validation Results
- Divergence creation: 200 bps sqrtPrice shift → 4.04% actual price move ✅
- Pool discovery: 5 pairs, 3 with spread above threshold ✅
- Opportunity detection: `opportunitiesFound: 1`, spreadBps: 395.9, 0 quote failures ✅
- Profitable round-trip: 100 USDT → 103.67 USDT (3.67% gross profit) ✅
- Execution pipeline: gas estimation reached contract → `BELOW_MIN_PROFIT` revert (expected: slot0-only manipulation doesn't update tick bitmap/liquidity, so actual on-chain swap diverges from QuoterV2 estimate) ✅
- Full pipeline validated from detection through to contract-level execution

### Verification Performed
- `npx tsc --noEmit` passed
- `npx hardhat compile` passed
- `npm run test` passed (77 passing, 0 failing, 1 pending)

### Phase 8+9 — Forknet Validation (Completed)
- Added `anvil` network configuration to `hardhat.config.ts`:
  - Points to local Anvil RPC (`http://127.0.0.1:8545`)
  - Uses Anvil default account when no `PRIVATE_KEY` is set
  - Chain ID 56 (BSC), legacy gas price 3 gwei
- Created `scripts/anvil-fork.sh`:
  - Shell script to start Anvil forking BSC mainnet
  - Sources `.env` for `CHAINSTACK_HTTP_URL` as fork origin
  - Configurable port via `ANVIL_PORT`, 1s block time for testing
- Created `scripts/deploy-fork.ts`:
  - Deploys `FlashSwapArbitrage` to Anvil fork via `hardhat --network anvil`
  - Post-deploy verification (owner, factory, deployer read-back)
- Created `scripts/run-fork-bot.ts` — full E2E fork bot runner:
  - Spawns Anvil as child process, waits for ready signal
  - Funds test wallet via `anvil_setBalance` (no real BNB needed)
  - Deploys contract from compiled artifacts (no Hardhat runtime dependency)
  - Runs pool discovery against forked BSC factory contracts
  - Runs WebSocket price feed + opportunity detection loop
  - Executes arbitrage via `ExecutionEngine` (dry-run default, live with `FORK_DRY_RUN=false`)
  - Private TX submitter configured with unreachable builder URLs → falls through to public RPC (Anvil local node)
  - Configurable cycle count (`FORK_MAX_CYCLES`), graceful Anvil cleanup
- Added npm scripts: `fork:start`, `fork:deploy`, `fork:bot`
- Updated `.env.example` with fork-related variables (`ANVIL_PORT`, `ANVIL_RPC_URL`, `FORK_MAX_CYCLES`, `FORK_DRY_RUN`)

### Verification Performed (Post Phase 8+9 Forknet)
- `npx tsc --noEmit` passed
- `npx hardhat compile` passed
- `npm run test` passed
  - 77 passing tests
  - 0 failing tests
  - 1 pending test (fork integration, env-gated)

## 2026-03-14

### Architecture & Planning
- Finalized system architecture and strategy in `arbitrage_architecture_plan.md`.
- Confirmed all key design decisions (BSC target, flash-swap model, private TX route, 2-leg scope, one-TX concurrency).
- Incorporated critical research findings:
  - BSC 0.45s block time constraints
  - BSC builder/MEV centralization and private submission requirement
  - V3 swap-callback repayment model and CREATE2 callback verification requirements

### Phase 1 — Scaffolding (Completed)
- Initialized TypeScript + Hardhat project with strict TS config.
- Added dual Solidity compiler setup (`0.8.20` + `0.7.6`) and BSC network configuration.
- Added environment template and base config modules:
  - `src/config/constants.ts`
  - `src/config/pools.ts`
  - `src/config/tokens.ts`
- Added core contract interfaces and pool address library.

### Phase 2 — FlashSwap Contract + Tests (Completed)
- Implemented `contracts/FlashSwapArbitrage.sol` with nested callback flow.
- Applied callback correctness/security fixes:
  - Removed unnecessary `approve()` in callback path
  - Added CREATE2-based callback caller verification for repay callback
  - Switched to swap-return deltas instead of `balanceOf()` inference
  - Fixed token delta resolution logic in repay path
- Added deployment script:
  - `scripts/deploy.ts`
- Added deterministic contract tests:
  - `test/FlashSwapArbitrage.test.ts`
  - `contracts/mocks/FakeCallbackCaller.sol`
  - `contracts/mocks/MockERC20.sol`
- Added fork-only env-gated integration test:
  - `test/integration/FlashSwapArbitrage.fork.test.ts`
- Updated Hardhat config so forking is opt-in instead of always-on, improving local/CI stability.

### Phase 3 — Price Feed + Pool State (Completed Baseline)
- Implemented pool state cache:
  - `src/feeds/PoolStateCache.ts`
- Implemented tick data provider:
  - `src/feeds/TickDataProvider.ts`
- Implemented multicall-based price feed with WS primary + HTTP fallback:
  - `src/feeds/PriceFeed.ts`
- Added structured logger utility:
  - `src/utils/logger.ts`
- Wired feed startup in `src/index.ts`.

### Dynamic Factory Discovery (Completed)
- Implemented factory-based pool discovery:
  - `src/feeds/PoolDiscovery.ts`
- Supports two discovery modes:
  - `whitelist` (seed pairs + `getPool` checks)
  - `events` (PoolCreated log scan + intersection)
- Added discovery environment configuration:
  - `POOL_DISCOVERY_MODE`
  - `POOL_DISCOVERY_EVENTS_LOOKBACK_BLOCKS`
  - `POOL_DISCOVERY_EVENTS_CHUNK_SIZE`
  - `POOL_DISCOVERY_MAX_POOLS`
- Wired discovery output into feed monitoring bootstrap.

### Phase 4 — Opportunity Detection (Completed Baseline)
- Implemented utility modules:
  - `src/utils/retry.ts`
  - `src/utils/decimals.ts`
  - `src/utils/math.ts`
- Implemented optimal amount approximation:
  - `src/strategy/OptimalAmount.ts`
- Implemented opportunity detection pipeline:
  - `src/strategy/OpportunityDetector.ts`
- Wired detector into feed update loop in `src/index.ts`.

### Reliability / Config Hardening
- Improved `hardhat.config.ts` private key handling:
  - validates key format
  - avoids hard-failing compile/test when deploy key is missing/invalid

### Verification Performed
- `npx tsc --noEmit` passed
- `npx hardhat compile` passed
- `npm run test` passed
  - 16 passing tests
  - 1 pending test (fork integration, expected when env-gated conditions are not enabled)

### Phase 5 — Execution Engine (Completed)
- Implemented gas estimation module:
  - `src/execution/GasEstimator.ts`
  - Gas price fetching via `getFeeData()`, configurable buffer (default 1.2x), max gas price cap, gas limit cap
- Implemented private transaction submitter:
  - `src/execution/PrivateTxSubmitter.ts`
  - Multi-builder proxy: Blockrazor primary → 48 Club fallback → public RPC last resort
  - Timeout handling via AbortController, JSON-RPC `eth_sendRawTransaction` format
- Implemented execution engine:
  - `src/execution/ExecutionEngine.ts`
  - Consumes `Opportunity` from detector, encodes `ArbParams` struct matching Solidity contract
  - Single-TX concurrency lock (skip new opportunities while pending)
  - Gas estimation check, dry-run logging mode (default), signed TX submission, receipt polling
- Wired execution engine into main loop (`src/index.ts`):
  - Wallet construction from `PRIVATE_KEY` env var
  - Engine executes top opportunity after detection
  - Graceful shutdown handlers (SIGINT/SIGTERM) with Discord notification
- Added execution configuration to `src/config/constants.ts`:
  - `EXECUTION` block: `dryRun`, `contractAddress`, `gasLimitBuffer`, `gasLimitCap`, `txConfirmationTimeoutMs`, `receiptPollIntervalMs`
- Corrected builder endpoint defaults (validated via librarian research):
  - 48 Club: `https://api.48.club/eth/v1/rpc` (deprecated) → `https://rpc.48.club`
  - Blockrazor: regional endpoints → default `https://hongkong.builder.blockrazor.io`
- Updated `.env.example` with execution-related variables:
  - `DRY_RUN`, `GAS_LIMIT_BUFFER`, `GAS_LIMIT_CAP`, `TX_CONFIRMATION_TIMEOUT_MS`, `RECEIPT_POLL_INTERVAL_MS`

### Phase 6 — Discord Monitoring (Completed)
- Extended `src/monitoring/DiscordNotifier.ts` with execution lifecycle alerts:
  - `sendShutdown()`, `sendTxSubmitted()`, `sendTxConfirmed()`, `sendTxReverted()`, `sendTxError()`
  - Error swallowing in `send()` — Discord failures never crash the bot
- Wired Discord notifications for tx lifecycle events in main loop

### Verification Performed (Post Phase 5+6)
- `npx tsc --noEmit` passed
- `npx hardhat compile` passed
- `npm run test` passed
  - 16 passing tests
  - 1 pending test (fork integration, expected when env-gated conditions are not enabled)

### Phase 7 — Integration Testing (Completed)
- Added comprehensive unit tests for all execution and monitoring modules:
  - `test/unit/PoolStateCache.test.ts` — 8 tests (upsert/get, overwrite, pruning, clear, getByPair)
  - `test/unit/RollingDetectorMetrics.test.ts` — 5 tests (empty state, samples, window pruning, failure rates)
  - `test/unit/GasEstimator.test.ts` — 6 tests (buffer, gas cap, revert, gasLimitCap, getMaxGasPriceWei)
  - `test/unit/PrivateTxSubmitter.test.ts` — 6 tests (builder proxy, fallbacks, JSON-RPC errors, network errors)
  - `test/unit/ExecutionEngine.test.ts` — 12 tests (dry run, concurrency lock, ArbParams encoding, full flow, receipt timeout)
  - `test/unit/DiscordNotifier.test.ts` — 13 tests (all send methods, error truncation, error swallowing)
- Added end-to-end integration test:
  - `test/integration/fullCycle.test.ts` — 4 tests (dry-run cycle, live execution, empty cache, single-DEX pair)
- All tests use hand-rolled mocks (no sinon) matching existing codebase patterns
- Fork-gated integration test kept as pending when `HARDHAT_ENABLE_FORKING` not set

### Verification Performed (Post Phase 7)
- `npx tsc --noEmit` passed
- `npx hardhat compile` passed
- `npm run test` passed
  - 77 passing tests
  - 0 failing tests
  - 1 pending test (fork integration, env-gated)
