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
- Phase 8 (Mainnet deployment + read-only monitor): ⬜ Not started
- Phase 9 (Live execution): ⬜ Not started

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

### Deployment tasks
- Deploy `FlashSwapArbitrage` to BSC mainnet
- Save deployed contract address in env/config
- Post-deploy read-back validation (owner/factories/init hashes)

### Read-only runtime validation
- Run bot in detect-only mode (no tx submission)
- Verify discovery/feed/detector stability over sustained runtime

---

## Phase 9 — Live Execution

### Prerequisites
- Private tx route confirmed operational
- Risk controls enabled and validated
- Monitoring alerts verified end-to-end

### Rollout plan
- Start with smallest borrow range
- Enable strict profitability threshold
- Observe success/revert rates before widening scope

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
