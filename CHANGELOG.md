# Changelog

All notable project changes are tracked here.

## 2026-03-15

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
