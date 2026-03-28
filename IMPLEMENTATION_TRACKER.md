# Implementation Tracker

This document tracks remaining work after the current completed baseline.

## Current Status Snapshot

- Architecture: ✅ Complete
- Phase 1 (Scaffold): ✅ Complete
- Phase 2 (Contract + Tests + Deploy script): ✅ Complete baseline
- Phase 3 (Feed + Cache + Discovery): ✅ Complete baseline
- Phase 4 (Opportunity detector + optimal amount): ✅ Complete baseline
- Phase 5 (Execution engine + private TX): ✅ Complete baseline
- Phase 6 (Discord monitoring integration): ✅ Complete baseline
- Phase 7 (Full integration test cycle on fork): ✅ Complete baseline
- Phase 8 (Mainnet deployment + read-only monitor): ✅ Forknet baseline complete
- Phase 9 (Live execution): ✅ Forknet E2E validated (detection → execution pipeline)
- Forknet divergence testing: ✅ Complete (buy/sell bug fixed, full pipeline verified)
- Contract deployed to BSC mainnet: ✅ `0xda33F478A186b7425Ac03e58Db081c433dfEc500`
- 10-minute mainnet dry-run smoke test: ✅ Passed
- Telemetry system: ✅ Complete (JSONL writer + per-pair/per-block records + persistent file storage)
- Event-driven monitoring (OPT-5): ✅ Complete (feature branch `feature/event-driven-monitoring`)
- Pluggable optimizer interface + adaptive grid: ✅ Complete

---

## Remaining Work

## Phase 5 — Execution Engine (Completed)

### Implemented modules
- `src/execution/GasEstimator.ts` — Gas price fetching, configurable buffer (default 1.2x), max gas price cap check, gas limit cap
- `src/execution/PrivateTxSubmitter.ts` — Multi-builder proxy: Blockrazor primary → 48 Club fallback → public RPC last resort; timeout handling; JSON-RPC `eth_sendRawTransaction` format
- `src/execution/ExecutionEngine.ts` — Consumes detector output, encodes ArbParams struct matching Solidity contract, single-TX concurrency lock, gas estimation check, dry-run mode (default), signed TX submission, receipt polling with configurable timeout

### Capabilities delivered
- Convert top opportunity into executable tx params for `FlashSwapArbitrage.executeArbitrage`.
- Gas estimation and guardrails:
  - max gas price cap
  - gas limit buffering
  - skip trade on invalid estimate
- Private tx path:
  - Blockrazor (hongkong.builder.blockrazor.io) primary
  - 48 Club (rpc.48.club) fallback
  - Public RPC last resort
- Concurrency policy:
  - one pending tx at a time
  - skip new opportunities while pending
- Wired into main loop (`src/index.ts`):
  - Wallet construction from PRIVATE_KEY env var
  - Engine executes top opportunity after detection
  - Discord notifications for tx submitted/confirmed/reverted/error
  - Graceful shutdown with SIGINT/SIGTERM handlers
- `DRY_RUN=true` by default — no live transactions unless explicitly disabled
- Detect-only mode when PRIVATE_KEY not set

### Builder endpoint validation (via librarian research)
- 48 Club: `https://api.48.club/eth/v1/rpc` deprecated → corrected to `https://rpc.48.club`
- Blockrazor: regional endpoints (virginia/frankfurt/hongkong) → default `https://hongkong.builder.blockrazor.io`
- Both use standard `eth_sendRawTransaction` JSON-RPC method

---

## Phase 6 — Monitoring (Completed)

### Implemented module
- `src/monitoring/DiscordNotifier.ts`

### Capabilities delivered
- Alert events:
  - bot startup (`sendStartup`)
  - bot shutdown (`sendShutdown`)
  - detector status rolling summary (`sendStatus`)
  - detector warnings (`sendWarning`)
  - tx submitted (`sendTxSubmitted`)
  - tx confirmed (`sendTxConfirmed`)
  - tx reverted (`sendTxReverted`)
  - tx submission error (`sendTxError`)
- Error swallowing in `send()` — Discord failures never crash the bot
- Wired into main loop with cooldown timers for status/alert Discord messages

---

## Phase 7 — Integration Testing (Completed)

### Implemented unit tests

- `test/unit/PoolStateCache.test.ts` — 8 tests
  - upsert/get, overwrite, unknown pool, different DEXes, getAll, getByPair, pruneOlderThan, clear
- `test/unit/RollingDetectorMetrics.test.ts` — 5 tests
  - empty state, single/multiple samples, window pruning, quote failure rate, budget exhaustion rate
- `test/unit/GasEstimator.test.ts` — 6 tests
  - buffered gas limit, gas price exceeds cap, unavailable gas price, estimateGas reverts, gasLimitCap enforcement, exact buffer multiplier, getMaxGasPriceWei
- `test/unit/PrivateTxSubmitter.test.ts` — 6 tests
  - builder proxy success, fallback to 48 Club, fallback to public RPC, JSON-RPC error handling, empty result, network errors
- `test/unit/ExecutionEngine.test.ts` — 12 tests
  - isDryRun, hasPendingTx, empty contract address, gas estimation failure, dry run mode, concurrency lock, ArbParams encoding, full success flow, reverted receipt, submission failure, receipt timeout, sqrtPriceLimitX96
- `test/unit/DiscordNotifier.test.ts` — 13 tests
  - isEnabled, disabled send, sendStartup, sendShutdown, sendStatus, sendWarning, sendTxSubmitted, sendTxConfirmed, sendTxReverted, sendTxError, error truncation, error swallowing (fetch throw + HTTP error)

### Implemented integration test

- `test/integration/fullCycle.test.ts` — 4 tests
  - Full dry-run cycle: cache → detector → rolling metrics → engine (dry run)
  - Full live execution flow with mocked dependencies
  - Empty cache gracefully (no crash, no opportunities)
  - Single-DEX pair (no cross-DEX opportunities detected)
- Fork-gated test (`HARDHAT_ENABLE_FORKING=true`) kept as pending/skipped when env not set

### Testing approach
- No external mocking libraries (no sinon) — hand-rolled stubs/fakes throughout
- Mock wallet for ethers v6: `{ address, signTransaction, provider: { resolveName }, getAddress, resolveName, connect }`
- Valid 20-byte hex addresses for all pool/contract mocks (ethers v6 ABI encoder validation)
- Fork tests env-gated via `HARDHAT_ENABLE_FORKING` + `CHAINSTACK_HTTP_URL`

### Quality gates met
- `npx tsc --noEmit` — clean (0 errors)
- `npx hardhat compile` — clean
- `npm run test` — **77 passing, 0 failing, 1 pending** (fork-gated)
- Stable run on non-fork mode (CI/local default)

---

## Phase 8 — Mainnet Deployment & Read-only Validation

### Forknet Validation (Completed)

- Added `anvil` network to `hardhat.config.ts` pointing to local Anvil RPC
- Created `scripts/anvil-fork.sh` — starts Anvil forking BSC mainnet with correct chain ID, gas price, and block time
- Created `scripts/deploy-fork.ts` — deploys `FlashSwapArbitrage` to Anvil fork via Hardhat `--network anvil`
- Created `scripts/run-fork-bot.ts` — full E2E fork bot runner:
  - Spawns Anvil programmatically (waits for `Listening on` stdout)
  - Funds test wallet via `anvil_setBalance`
  - Deploys contract from compiled artifacts
  - Runs pool discovery against forked factory contracts
  - Runs price feed (WebSocket) + opportunity detection loop
  - Executes arbitrage (dry-run by default, live with `FORK_DRY_RUN=false`)
  - Configurable cycle count via `FORK_MAX_CYCLES`
  - Graceful cleanup (stops Anvil process on exit)
- Private TX submitter intentionally configured with unreachable builder URLs on fork — falls through to public RPC (Anvil), which is correct behavior
- Added npm scripts: `fork:start`, `fork:deploy`, `fork:bot`
- Added fork-related env vars to `.env.example`

### Forknet Divergence Testing (Completed)

- Created `scripts/create-fork-divergence.ts` — slot0 storage manipulation for artificial price divergence
- Fixed buy/sell pool inversion bug in `OpportunityDetector.ts` (buyPool was incorrectly assigned to lower-price pool)
- Fixed missing `from` field in `ExecutionEngine.ts` gas estimation (caused `NOT_OWNER` revert)
- E2E pipeline validated: divergence → detection (395 bps spread) → profitable opportunity (100→103.67 USDT) → gas estimation → contract execution attempt
- Contract reverts with `BELOW_MIN_PROFIT` as expected (slot0 manipulation doesn't update liquidity/tick bitmap, so actual swap differs from QuoterV2 estimate)
- This is the known limitation of fork testing — the important validation is that the entire code path executes correctly

### Mainnet Deployment (Not yet started)
- Deploy `FlashSwapArbitrage` to BSC mainnet
- Save deployed contract address in env/config
- Post-deploy read-back validation (owner/factories/init hashes)

### Read-only Runtime Validation (Not yet started)
- Run bot in detect-only mode (no tx submission)
- Verify discovery/feed/detector stability over sustained runtime

---

## Phase 9 — Live Execution

### Forknet Validation (Completed)
- Full execution path validated on Anvil fork (see Phase 8 forknet section above)
- Contract deployment, pool discovery, price feed, detection, and execution all wired end-to-end
- Divergence testing confirms profitable opportunity detection and contract-level execution attempt

### Mainnet Prerequisites (Not yet started)
- Private tx route confirmed operational
- Risk controls enabled and validated
- Monitoring alerts verified end-to-end

---

## Telemetry System (Completed)

### Implemented modules
- `src/monitoring/TelemetryWriter.ts` — Async buffered JSONL writer with file rotation
- Integration in `src/strategy/OpportunityDetector.ts` — Per-pair telemetry emission in detect loop
- Wired in `src/index.ts` — TelemetryWriter lifecycle (start/stop) + injection into detector
- Config in `src/config/constants.ts` — `TELEMETRY` block reading from env vars

### Capabilities delivered
- Per-pair, per-block structured telemetry written to JSONL files in `data/telemetry/`
- Pair records include: prices, spread, quote results, profit estimates, reject reasons
- Block records include: pairs scanned, spreads found, opportunities, duration
- Async buffered writes (no hot-path I/O blocking)
- Configurable buffer size, flush interval, file rotation threshold
- Enable/disable via `TELEMETRY_ENABLED` env var
- Graceful shutdown flushes remaining buffer

### Configuration (env vars)
- `TELEMETRY_ENABLED` (default: `true`)
- `TELEMETRY_DATA_DIR` (default: `data/telemetry`)
- `TELEMETRY_BUFFER_SIZE` (default: `100`)
- `TELEMETRY_FLUSH_INTERVAL_MS` (default: `5000`)
- `TELEMETRY_MAX_FILE_SIZE_MB` (default: `50`)

---

## OPT-5: Event-Driven Pool Monitoring (Completed)

Replaces block-based polling with WebSocket log subscriptions for Swap, Mint, and Burn events. Feature-flagged via `EVENT_DRIVEN_ENABLED` (default: `false` for backward compatibility).

### Implemented modules
- `src/feeds/EventListener.ts` — Core event subscription class (~310 lines)
  - Single WSS `eth_subscribe("logs")` with OR-matched topic0 array covering 4 event types
  - Handles **different** PancakeSwap V3 Swap signature (9 params vs Uniswap's 7) via shared ABI decode trick
  - LRU dedup cache (configurable, default 5000 entries) by `txHash:logIndex`
  - Gap backfill via `eth_getLogs` on fallback HTTP provider
  - `fetchPoolState()` for Mint/Burn follow-up (single-pool Multicall3 for slot0 + liquidity)
  - Callbacks: `onSwap(poolAddress, sqrtPriceX96, tick, liquidity)`, `onLiquidityChange(poolAddress, sqrtPriceX96, tick, liquidity)`

### Modified modules
- `src/feeds/PoolStateCache.ts` — Added `getByAddress(poolAddress)` reverse lookup
- `src/feeds/PriceFeed.ts` — Added `updateSinglePool(poolAddress, dynamic)` for event-driven cache updates; added `fallbackPollBlocks` option (poll every N blocks instead of every block)
- `src/config/constants.ts` — Added `EVENT_DRIVEN` config block
- `src/index.ts` — Refactored detection loop:
  - Extracted `runDetection()` and `triggerDetection()` functions
  - EventListener wired with onSwap (zero RPC → cache update → per-pair detection)
  - EventListener wired with onLiquidityChange (1 RPC → cache update → per-pair detection)
  - Per-pair debounce via `pendingDetections` Map with configurable timeout
  - Fallback poll via `feed.onUpdate` still runs every N blocks
  - Feature flag: `EVENT_DRIVEN_ENABLED=false` disables event-driven path entirely
  - Graceful EventListener stop on shutdown

### Key design decisions
- **D1**: Single WSS subscription with topic0 OR-array (not per-pool subscriptions) — O(1) subscriptions
- **D2**: Swap events provide sqrtPriceX96/tick/liquidity directly — zero follow-up RPC needed
- **D3**: Mint/Burn events need slot0()+liquidity() follow-up — single Multicall3 per event
- **D4**: Per-pair debounce prevents detection storms during high-activity periods
- **D5**: Block-poll fallback (every N blocks) catches any missed events
- **D6**: Dedup by txHash+logIndex handles reorg-induced duplicates
- **D7**: Feature flag allows instant rollback to pure block-polling

### Event signature discovery
| DEX | topic0 |
|-----|--------|
| Uniswap V3 Swap | `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67` |
| PancakeSwap V3 Swap | `0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83` |
| Mint (both) | `0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde` |
| Burn (both) | `0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c` |

### Unit tests added
- `test/unit/EventListener.test.ts` — 12 tests
  - UNI/PCS Swap parsing, Mint/Burn parsing, unknown pool, unknown topic, dedup, topic constants, case-insensitive matching, backfill edge cases

### Configuration (env vars)
- `EVENT_DRIVEN_ENABLED` (default: `false`)
- `FALLBACK_POLL_BLOCKS` (default: `1` — every block, same as before)
- `EVENT_DEBOUNCE_MS` (default: `50`)
- `EVENT_DEDUP_CACHE_SIZE` (default: `5000`)

### Quality gates met
- `npx tsc --noEmit` — clean (0 errors)
- `npm run test` — **133 passing, 0 failing, 1 pending** (fork-gated)
- Feature flag off = identical behavior to pre-OPT-5 baseline

### Detailed plan
- `.sisyphus/plans/event-driven-monitoring.md` — Full spec with D1-D7 design decisions, 7 implementation steps, R1-R5 risk assessment

### Rollout plan
- Start with `EVENT_DRIVEN_ENABLED=false` (default) — pure block-polling
- Enable on paid Chainstack tier ($49/mo, 250 RPS, 20M req/month) for WSS stability
- Monitor WSS connection stability and event delivery before disabling block-poll fallback

---

## Pluggable Optimizer Interface + Adaptive Grid (Completed)

### Architecture changes
- Extracted `IOptimizer` interface (`src/strategy/IOptimizer.ts`) — shared types for `ProfitPoint`, `OptimizerMetrics`, `OptimizerResult`, `OptimizerFactory`
- `OpportunityDetector` now depends on `IOptimizer` via factory pattern — any optimizer implementing the interface can be injected without touching other code
- `HybridAmountOptimizer` implements `IOptimizer` (backward compat preserved via type aliases)

### New module
- `src/strategy/AdaptiveGridOptimizer.ts` — log-scale grid with default ratios `[10, 50, 100, 300, 700, 1500, 3500, 6500, 9000]` bps
  - Covers small trade sizes ($50-$500) that old linear grid missed entirely
  - Configurable grid ratios, budget cap, min/max amounts
  - Supports both sequential and batch evaluation
  - Default optimizer for `OpportunityDetector`

### Removed features
- Parabolic interpolation (was in `HybridAmountOptimizer`)
- Golden section refinement (was in `HybridAmountOptimizer`)
- `refineIterations` option removed from `HybridAmountOptimizerOptions`
- `optimizerParabolicAcceptedCount` removed from `DetectorRunMetrics`
- `optimizerParabolicAcceptedRate` removed from `RollingDetectorSummary`

### Files modified
- `src/strategy/IOptimizer.ts` (new)
- `src/strategy/AdaptiveGridOptimizer.ts` (new)
- `src/strategy/HybridAmountOptimizer.ts` (rewritten)
- `src/strategy/OpportunityDetector.ts` (refactored)
- `src/monitoring/RollingDetectorMetrics.ts` (removed parabolic metrics)
- `src/index.ts` (removed parabolic logging)
- `scripts/run-fork-bot.ts` (removed old optimizer options)
- `test/unit/HybridAmountOptimizer.test.ts` (rewritten)
- `test/unit/AdaptiveGridOptimizer.test.ts` (new — 10 tests)
- `test/unit/RollingDetectorMetrics.test.ts` (updated)
- `test/unit/DiscordNotifier.test.ts` (updated)
- `test/integration/fullCycle.test.ts` (updated)

### Quality gates met
- `npx tsc --noEmit` — clean (0 errors)
- `npm run test` — **139 passing, 0 failing, 1 pending** (fork-gated)

---

## Open Design / Confirmation Items

1. **Execution mode default** — ✅ Resolved: `DRY_RUN=true` by default.

2. **Builder routing strategy** — ✅ Resolved: Blockrazor primary → 48 Club fallback → public RPC last resort. Endpoints validated via librarian research.

3. **Profit threshold policy**
   - Current baseline uses static threshold from env.
   - Optional enhancement: dynamic threshold based on recent gas + revert rate.

4. **Fork test policy**
   - Keep fork tests env-gated and non-blocking by default.

---

## Environment Checklist (Current)

Set in `.env`:
- `CHAINSTACK_WSS_URL` ✅
- `CHAINSTACK_HTTP_URL` ✅
- `ALCHEMY_HTTP_URL` ✅
- `DISCORD_WEBHOOK_URL` ✅
- `BUILDER_PROXY_URL` ✅ (default: `https://hongkong.builder.blockrazor.io`)
- `BUILDER_48CLUB_URL` ✅ (default: `https://rpc.48.club`)
- `DRY_RUN` ✅ (default: `true`)
- `GAS_LIMIT_BUFFER` ✅ (default: `1.2`)
- `GAS_LIMIT_CAP` ✅ (default: `1000000`)
- `TX_CONFIRMATION_TIMEOUT_MS` ✅ (default: `15000`)
- `RECEIPT_POLL_INTERVAL_MS` ✅ (default: `500`)

Still needed for later phases:
- `PRIVATE_KEY` (valid 32-byte hex — required for live execution, optional for detect-only mode)
- `FLASH_SWAP_ARBITRAGE_ADDRESS` (set after contract deployment)

### Fork Testing Variables (Added)
- `ANVIL_PORT` (default: `8545`)
- `ANVIL_RPC_URL` (default: `http://127.0.0.1:8545`)
- `FORK_MAX_CYCLES` (default: `20`)
- `FORK_DRY_RUN` (default: `true`)
