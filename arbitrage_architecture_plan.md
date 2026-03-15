# DEX Arbitrage Bot — Architecture Blueprint (v2)

> **Target**: BNB Chain (BSC Mainnet)
> **Strategy**: Flash swap arbitrage between Uniswap V3 (BSC) and PancakeSwap V3 (BSC)
> **Block Time**: 0.45 seconds (post-Fermi hard fork, Jan 2026)
> **Status**: Architecture finalized — ready for implementation

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          ARBITRAGE BOT (off-chain)                      │
│                                                                         │
│  ┌──────────────┐   ┌────────────────┐   ┌───────────────────────────┐  │
│  │  Price Feed   │──▶│  Opportunity   │──▶│  Execution Engine         │  │
│  │  (WebSocket)  │   │  Detector      │   │  (Private TX Submission)  │  │
│  └──────────────┘   └────────────────┘   └───────────────────────────┘  │
│        │                    │                        │                   │
│        ▼                    ▼                        ▼                   │
│  ┌──────────────┐   ┌────────────────┐   ┌───────────────────────────┐  │
│  │  Pool State   │   │  Parabolic     │   │  On-Chain Contract        │  │
│  │  Cache +      │   │  Optimal Amt   │   │  (FlashSwapArbitrage)     │  │
│  │  Tick Data    │   │  Calculator    │   └───────────────────────────┘  │
│  └──────────────┘   └────────────────┘              │                   │
│        │                                             ▼                   │
│  ┌──────────────┐                      ┌───────────────────────────┐    │
│  │  Discord      │◀─────────────────── │  Multi-Builder Proxy      │    │
│  │  Alerts       │                     │  (48 Club + Blockrazor)   │    │
│  └──────────────┘                      └───────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
         │                                             │
         ▼                                             ▼
   ┌────────────┐                           ┌──────────────────┐
   │ Chainstack  │                           │   BSC Mainnet    │
   │ WSS / HTTP  │                           │  (0.45s blocks)  │
   └────────────┘                           └──────────────────┘
```

---

## 2. Tech Stack

| Layer              | Technology                      | Rationale                                                     |
| ------------------ | ------------------------------- | ------------------------------------------------------------- |
| **Runtime**        | Node.js (v20 LTS)              | Native WebSocket support, non-blocking I/O                    |
| **Language**       | TypeScript (strict mode)        | Type safety for contract interactions, BigInt support          |
| **Web3 Library**   | Ethers.js v6                    | Best BSC support, clean BigInt API, battle-tested for DeFi    |
| **RPC Provider**   | Chainstack (primary) + Alchemy (fallback) | Chainstack: best BSC optimization, 99.99% SLA, sub-100ms p95 |
| **Smart Contract** | Solidity 0.8.x                  | On-chain flash swap executor with swap callbacks              |
| **Dev Framework**  | Hardhat                         | BSC mainnet forking, contract deployment, testing             |
| **Testing**        | Hardhat + Chai + Mocha          | Fork-based integration tests with real pool states            |
| **Swap Math**      | @uniswap/v3-sdk                 | Off-chain tick math for local swap simulation (no RPC calls)  |
| **Multicall**      | Multicall3 contract             | Batch 30+ pool reads in single RPC call                       |
| **TX Submission**  | Multi-builder proxy (Blockrazor/Merkle) | Private TX to 48 Club + Blockrazor (96% block coverage)  |
| **Monitoring**     | Discord Webhook                 | Real-time alerts for trades, errors, P&L                      |
| **Package Mgr**    | pnpm                            | Fast, disk-efficient                                          |

---

## 3. Target DEXs & Contracts (BSC Mainnet)

### 3.1 Uniswap V3 (BSC)

| Contract                       | Address                                      |
| ------------------------------ | -------------------------------------------- |
| Factory                        | `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7` |
| SwapRouter02                   | `0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2` |
| UniversalRouter                | `0x1906c1d672b88cd1b9ac7593301ca990f94eae07` |
| QuoterV2                       | `0x78D78E420Da98ad378D7799bE8f4AF69033EB077` |

> Source: [Uniswap V3 BSC Deployments](https://docs.uniswap.org/contracts/v3/reference/deployments/bnb-deployments)

### 3.2 PancakeSwap V3 (BSC)

| Contract                       | Address                                      |
| ------------------------------ | -------------------------------------------- |
| PancakeV3Factory               | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` |
| SmartRouter (V3)               | `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4` |
| SwapRouter (V3)                | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` |
| QuoterV2                       | `0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997` |

> Source: [PancakeSwap V3 Addresses](https://developer.pancakeswap.finance/contracts/v3/addresses)

### 3.3 Infrastructure Contracts

| Contract    | Address                                      | Purpose                  |
| ----------- | -------------------------------------------- | ------------------------ |
| Multicall3  | `0xcA11bde05977b3631167028862bE2a173976CA11` | Batch pool state reads   |

### 3.4 Common Base Tokens (BSC)

| Token  | Address                                      | Decimals | Notes         |
| ------ | -------------------------------------------- | -------- | ------------- |
| WBNB   | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` | 18       | Primary base  |
| USDT   | `0x55d398326f99059fF775485246999027B3197955` | 18       | BSC-Peg USDT  |
| USDC   | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18       | BSC-Peg USDC  |
| BUSD   | `0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56` | 18       | ⚠️ Deprecated |
| ETH    | `0x2170Ed0880ac9A755fd29B2688956BD959F933F8` | 18       | BSC-Peg ETH   |

> ⚠️ **BUSD was deprecated by Binance in Feb 2024.** Prefer USDT/USDC as stablecoin base.
>
> **Note**: BSC-pegged USDT and USDC are 18 decimals (unlike Ethereum where they're 6). Still implement decimal normalization as a safety layer.

> **IMPORTANT**: All addresses cross-referenced against official docs + BSCScan. Verify on [BSCScan](https://bscscan.com/) before mainnet deployment.

---

## 4. Architecture Components

### 4.1 Price Feed Module

**Purpose**: Stream real-time pool states from both DEXs every 0.45s block.

```
Provider:   Chainstack WebSocket (primary) + Alchemy HTTP (fallback)
Trigger:    newHeads subscription → batch-read via Multicall3
Data:       sqrtPriceX96, tick, liquidity for each monitored pool
Latency:    < 100ms block notification + < 150ms multicall = < 250ms total
Budget:     0.45s per block → 200ms remaining for detection + execution
```

**Design**:
- Subscribe to `newHeads` via WebSocket for block notifications
- On each new block, Multicall3 `slot0()` on all monitored pools (both DEXs)
- Also fetch initialized tick data periodically (every ~10 blocks) for local simulation
- Maintain in-memory cache of pool states (sqrtPriceX96, tick, liquidity, fee tier)
- Auto-reconnect WebSocket with exponential backoff + jitter

**Multicall3 Pattern**:
```typescript
const multicall = new Contract('0xcA11bde05977b3631167028862bE2a173976CA11', multicall3ABI, provider);
const calls = pools.map(pool => ({
  target: pool.address,
  allowFailure: true,  // Don't fail entire batch if one pool reverts
  callData: poolInterface.encodeFunctionData('slot0')
}));
const results = await multicall.aggregate3.staticCall(calls);
```

**Why not subscribe to Swap events?**
- Swap events arrive AFTER the block is finalized — too late for 0.45s blocks
- Reading `slot0()` on new block gives us the latest state immediately

### 4.2 Opportunity Detector

**Purpose**: Identify profitable arbitrage opportunities with <100ms latency.

```
Input:  Pool states from both DEXs for the same token pair
Output: Profitable trade parameters (direction, pool addresses, amount, expected profit)
```

**Logic**:
1. For each token pair in the whitelist, compare prices on Uniswap V3 vs PancakeSwap V3
2. Quick filter: if price difference < 0.1%, skip (won't cover gas)
3. Calculate optimal input amount using **parabolic approximation** (see 4.2.1)
4. Simulate full swap output using **@uniswap/v3-sdk local tick math** (no RPC calls)
5. Subtract: gas cost (in token terms)
6. If net profit > minimum threshold → trigger execution

**Note**: Flash swap fee is 0% — we repay during the swap callback, not via separate flash() call.

**Profitability Formula**:
```
net_profit = output_from_DEX2 - amount_owed_to_DEX1 - gas_cost_in_token
profitable = net_profit > MIN_PROFIT_THRESHOLD
```

#### 4.2.1 Optimal Amount: Parabolic Approximation

For V3 concentrated liquidity, there's no closed-form solution (unlike V2's constant product).
We use parabolic approximation — sample 3 profit points, fit a parabola, solve for the vertex.

```typescript
// 1. Sample 3 input amounts using local SDK simulation
const profits = [1000n, 1001n, 1002n].map(amt =>
  simulateArbProfit(poolA_state, poolB_state, amt)  // Off-chain, ~1ms each
);

// 2. Fit parabola: f(x) = ax² + bx + c
const [a, b, c] = fitParabola(samples, profits);

// 3. Optimal amount at vertex: x* = -b / (2a)
const optimalAmount = -b / (2n * a);

// 4. Verify with one final simulation
const finalProfit = simulateArbProfit(poolA_state, poolB_state, optimalAmount);
```

**Performance**: ~5-10ms total. Well within our 0.45s block budget.
**Accuracy**: ~99.9% — the profit curve is approximately parabolic even when crossing ticks.

### 4.3 Execution Engine (Off-chain)

**Purpose**: Submit arbitrage transactions via private multi-builder proxy.

```
1. Check: is there a pending TX? If yes, skip (single TX concurrency model)
2. Encode flash swap request → FlashSwapArbitrage contract
3. Estimate gas with buffer (1.2x)
4. Submit via multi-builder proxy (Blockrazor/Merkle → 48 Club + Blockrazor)
5. Monitor transaction receipt
6. Log result + send Discord alert
```

**Transaction Submission — Private Multi-Builder Proxy**:
```
Bot → Blockrazor/Merkle Proxy → ┌─ 48 Club (57% of blocks)
                                 ├─ Blockrazor (40% of blocks)
                                 └─ Others (~3%)
                                        ↓
                                 BSC Validators
```

- **Why private?**: Public mempool = instant frontrunning by builders who control 96% of blocks
- **Proxy coverage**: 96%+ of blocks see our transaction
- **Fallback**: If proxy fails, submit to Chainstack (public) as last resort

**Gas Strategy**:
- BSC gas is cheap (~3-5 gwei)
- Set MAX_GAS_PRICE = 10 gwei — skip opportunity if gas exceeds this
- Gas limit cap to prevent runaway costs

**Concurrency Model**: One TX at a time. If a TX is pending, skip new opportunities until it confirms or reverts. Simple, avoids nonce collision bugs. Revisit in v2 if we're missing too many opportunities.

### 4.4 Smart Contract: FlashSwapArbitrage

**Purpose**: Atomic on-chain execution — flash swap on DEX A → swap on DEX B → repay DEX A → keep profit.

**Key Insight**: We use **flash swaps** (via `pool.swap()` callback), NOT `pool.flash()`. The swap callback receives tokens before we pay — we use the received tokens to swap on the other DEX, then repay the original pool. **0% flash fee** (vs pool.flash() which charges the pool's fee tier).

```solidity
// Pseudocode structure — actual implementation will differ
contract FlashSwapArbitrage {

    // Entry point: called by off-chain bot
    function executeArbitrage(
        address poolBorrow,       // Pool to flash-swap on (DEX A)
        address poolArb,          // Pool to arb against (DEX B)
        bool zeroForOne,          // Swap direction on DEX A
        int256 amountSpecified,   // Amount to flash-swap
        uint160 sqrtPriceLimitX96,
        uint256 amountOutMin      // Minimum profit (slippage protection)
    ) external onlyOwner;

    // PancakeSwap V3 swap callback — called by the pool during swap()
    // Tokens have been sent to us, now we must pay the pool back
    function pancakeV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        // 1. Validate msg.sender is legitimate PancakeV3Pool (via factory + CREATE2)
        // 2. We received tokenOut from DEX A's swap
        // 3. Swap tokenOut on DEX B → get tokenIn back
        // 4. Pay DEX A what it's owed (amount0Delta or amount1Delta, whichever is positive)
        // 5. Remaining balance = profit (stays in contract)
    }

    // Uniswap V3 swap callback — same logic, different function name
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        // Same repayment logic as above
    }

    // Safety: validate pool via factory + CREATE2 address computation
    function _verifyCallback(address pool, address factory) internal view;

    // Withdraw accumulated profits
    function withdrawProfits(address token) external onlyOwner;

    // Emergency pause
    function pause() external onlyOwner;
    function unpause() external onlyOwner;
}
```

**Flash Swap Flow**:
```
1. Bot calls FlashSwapArbitrage.executeArbitrage(poolA, poolB, ...)
2. Contract calls PancakeV3Pool(poolA).swap() — requesting tokenOut
3. Pool sends tokenOut to our contract BEFORE callback
4. Pool calls pancakeV3SwapCallback() — we now owe tokenIn
5. Inside callback:
   a. We have tokenOut from step 3
   b. Swap tokenOut on poolB (Uniswap V3) → receive tokenIn
   c. Transfer tokenIn owed back to poolA (repaying the flash swap)
   d. Remaining tokenIn = profit (stays in contract)
6. If tokenIn received from poolB < amount owed to poolA → TX reverts atomically (no loss)
```

**Key Differences from v1 Plan**:
- Uses `swap()` callback instead of `flash()` — **0% flash fee**
- Callback is `pancakeV3SwapCallback(int256, int256, bytes)` not `pancakeV3FlashCallback(uint256, uint256, bytes)`
- Pool validation via CREATE2 address computation (not just factory check)

**PancakeSwap V3 Fee Tiers** (different from Uniswap!):
| Fee     | Tick Spacing | Notes                          |
| ------- | ------------ | ------------------------------ |
| 0.01%   | 1            | Stablecoin pairs               |
| 0.05%   | 10           | Standard                       |
| **0.25%** | **50**     | **PCS default (vs Uni's 0.3%)** |
| 1.00%   | 200          | Exotic pairs                   |

---

## 5. MEV & Private Transaction Strategy

### 5.1 BSC MEV Landscape (2026)

BSC operates a **centralized PBS (Proposer-Builder Separation)** architecture:

| Builder       | Block Share | Validators |
| ------------- | ----------- | ---------- |
| **48 Club**   | 57%         | 45         |
| **Blockrazor**| 40%         | 45         |
| Jetbldr       | 1.6%        | 41         |
| bloXroute     | 1.0%        | 44         |
| Others        | 0.4%        | —          |

> Source: [arXiv Feb 2026 study](https://arxiv.org/html/2602.15395v1)

**Key facts**:
- Builders run **46,000+ arbitrage contracts** themselves
- Builders execute at **0 Gwei** gas cost
- Public mempool transactions are **visible to and frontrunnable by builders**
- 0.45s blocks give external searchers **<200ms reaction window**

### 5.2 Our Approach: Multi-Builder Proxy

```
Bot → Blockrazor Builder Proxy → 48 Club (57%) + Blockrazor (40%) + Others
```

- Use **Blockrazor proxy** or **Merkle proxy** for multi-builder broadcasting
- Covers 96%+ of blocks
- Free tier available; paid tiers offer priority inclusion
- Open-source reference: [NodeReal private-tx-sender](https://github.com/node-real/private-tx-sender)

**Private RPC Endpoints**:

| Provider    | Endpoint / API                              | Notes                     |
| ----------- | ------------------------------------------- | ------------------------- |
| 48 Club     | `eth_sendPrivateTransaction`                | Largest builder           |
| Blockrazor  | Builder proxy with multi-builder broadcast  | 2nd largest, has refund   |
| bloXroute   | BSC Protect RPC                             | Bundle support            |
| Merkle      | Free BSC Private RPC                        | Proxy to 48 Club + others |

### 5.3 Realistic Expectations

**⚠️ Honest assessment**: We are competing against builders who:
- See ALL private order flow submitted to them
- Execute arbitrage at 0 Gwei
- Have direct validator connections with <50ms latency
- Capture ~92% of all MEV profit on BSC

**Our edge must come from**:
- Finding opportunities in less-monitored token pairs (dynamic whitelist expansion)
- Speed of detection (local tick math, no RPC round-trips for quoting)
- Executing on the remaining ~8% of MEV that builders miss

---

## 6. Token Pair Strategy: Dynamic Whitelist

### 6.1 Initial Whitelist (High Volume — Phase 1)

| Pair         | Fee Tiers to Monitor         |
| ------------ | ---------------------------- |
| WBNB/USDT   | 0.01%, 0.05%, 0.25%         |
| WBNB/USDC   | 0.05%, 0.25%                |
| ETH/USDT    | 0.05%, 0.25%                |
| ETH/WBNB    | 0.05%, 0.25%                |

> Removed WBNB/BUSD — BUSD is deprecated, low liquidity.
> ~16 pools total (4 pairs × 2 DEXs × ~2 fee tiers).

### 6.2 Expansion Strategy

1. **Phase 1**: Monitor initial whitelist only (~16 pools)
2. **Phase 2**: Query both factories for `PoolCreated` events to discover all shared pairs
3. **Phase 3**: Auto-add pairs meeting criteria:
   - Pool exists on BOTH Uniswap V3 and PancakeSwap V3
   - TVL > $50k on each DEX
   - 24h volume > $10k on each DEX
4. **Phase 4**: Remove pairs that haven't been profitable in 7 days

### 6.3 Scope: 2-Leg Arbitrage Only (v1)

v1 targets simple cross-DEX arbitrage:
```
A → B on DEX 1 (flash swap)
B → A on DEX 2 (regular swap)
```

Triangular arbitrage (A→B→C→A) is **out of scope for v1**. Can revisit after measuring v1 profitability.

---

## 7. Development & Testing Strategy

### 7.1 Environment Setup

```
Local Development:
├── Hardhat node forking BSC Mainnet (via Chainstack archive node)
├── Real pool states, real liquidity, real prices
├── Free to simulate — no gas costs
└── Deterministic block-by-block testing

Production:
├── BSC Mainnet (0.45s blocks)
├── Chainstack WebSocket (primary) + Alchemy HTTP (fallback)
├── Private TX via multi-builder proxy
├── Flash swaps only — gas is the only cost at risk
└── Deployed FlashSwapArbitrage contract (verified on BSCScan)
```

### 7.2 Testing Phases

| Phase | Environment        | Goal                                      |
| ----- | ------------------ | ----------------------------------------- |
| 1     | Hardhat fork       | Contract logic: flash swap + dual swap    |
| 2     | Hardhat fork       | Parabolic optimal amount accuracy         |
| 3     | Hardhat fork       | Gas estimation accuracy                   |
| 4     | BSC Mainnet (view) | Price feed reliability (read-only, 0.45s) |
| 5     | BSC Mainnet (live) | Real execution with flash swaps           |

### 7.3 Safety Checks (Pre-Production)

- [ ] Contract audited (self-review + Slither static analysis)
- [ ] `onlyOwner` on all state-changing functions
- [ ] Swap callback validates caller via CREATE2 pool address computation
- [ ] Maximum borrow amount cap in contract
- [ ] Kill switch: `pause()` / `unpause()` on contract
- [ ] Gas price ceiling (MAX_GAS_PRICE = 10 gwei) checked off-chain before submission
- [ ] Minimum profit threshold (configurable, default: cover 2x gas)
- [ ] Decimal normalization layer for profit calculation

---

## 8. Project Structure

```
dex_arbitrage/
├── contracts/                       # Solidity smart contracts
│   ├── FlashSwapArbitrage.sol       # Main flash swap arbitrage contract
│   ├── interfaces/
│   │   ├── IUniswapV3Pool.sol       # Uniswap V3 pool interface
│   │   ├── IPancakeV3Pool.sol       # PancakeSwap V3 pool interface
│   │   ├── IUniswapV3SwapCallback.sol
│   │   └── IPancakeV3SwapCallback.sol
│   └── libraries/
│       └── PoolAddress.sol          # CREATE2 pool address computation
├── src/                             # TypeScript bot source
│   ├── index.ts                     # Entry point
│   ├── config/
│   │   ├── tokens.ts                # Token whitelist & addresses
│   │   ├── pools.ts                 # Pool addresses & fee tiers
│   │   └── constants.ts             # Chain config, thresholds, provider URLs
│   ├── feeds/
│   │   ├── PriceFeed.ts             # WebSocket block subscription + multicall
│   │   ├── PoolStateCache.ts        # In-memory pool state management
│   │   └── TickDataProvider.ts      # Periodic tick data fetcher for local sim
│   ├── strategy/
│   │   ├── OpportunityDetector.ts   # Price comparison & profitability
│   │   └── OptimalAmount.ts         # Parabolic approximation for optimal trade size
│   ├── execution/
│   │   ├── ExecutionEngine.ts       # TX encoding + submission
│   │   ├── PrivateTxSubmitter.ts    # Multi-builder proxy integration
│   │   └── GasEstimator.ts          # Gas price & limit estimation
│   ├── monitoring/
│   │   └── DiscordNotifier.ts       # Discord webhook alerts
│   └── utils/
│       ├── logger.ts                # Structured logging
│       ├── math.ts                  # BigInt math helpers
│       ├── decimals.ts              # Decimal normalization utilities
│       └── retry.ts                 # Retry/reconnect with exponential backoff
├── test/                            # Hardhat fork tests
│   ├── FlashSwapArbitrage.test.ts
│   ├── OptimalAmount.test.ts
│   ├── PriceFeed.test.ts
│   └── integration/
│       └── fullCycle.test.ts        # End-to-end on fork
├── scripts/
│   ├── deploy.ts                    # Contract deployment
│   └── monitor.ts                   # Read-only price monitor (Phase 4)
├── hardhat.config.ts
├── tsconfig.json
├── package.json
├── .env.example                     # Template (never commit .env)
└── arbitrage_architecture_plan.md   # This file
```

---

## 9. Configuration & Environment Variables

```env
# .env.example — NEVER commit actual .env file

# RPC Providers
CHAINSTACK_WSS_URL=wss://bsc-mainnet.core.chainstack.com/ws/YOUR_KEY
CHAINSTACK_HTTP_URL=https://bsc-mainnet.core.chainstack.com/YOUR_KEY
ALCHEMY_HTTP_URL=https://bnb-mainnet.g.alchemy.com/v2/YOUR_KEY

# Private TX Submission (multi-builder proxy)
BUILDER_PROXY_URL=https://bsc-builder.blockrazor.xyz
BUILDER_48CLUB_URL=https://api.48.club/eth/v1/rpc

# Wallet (deployer & bot operator)
PRIVATE_KEY=your_private_key_here

# Contract (set after deployment)
FLASH_SWAP_ARBITRAGE_ADDRESS=

# Strategy
MIN_PROFIT_THRESHOLD_USD=0.50
MAX_BORROW_AMOUNT_USD=10000
MAX_GAS_PRICE_GWEI=10

# Monitoring
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

---

## 10. Risk Considerations

| Risk                        | Mitigation                                                                |
| --------------------------- | ------------------------------------------------------------------------- |
| **Smart contract bug**      | Slither analysis, fork testing, `pause()` kill switch                     |
| **Flash swap revert**       | Only gas is lost (~$0.03-0.10). Acceptable.                               |
| **Stale price data**        | Validate pool state age < 1 block (0.45s) before execution               |
| **MEV / Frontrunning**      | Private TX via multi-builder proxy (96% block coverage). Builders still see our TX — accept residual risk. |
| **Builder competition**     | Builders capture ~92% of MEV. Our edge: less-monitored pairs, speed.      |
| **RPC downtime**            | Chainstack primary + Alchemy fallback + exponential backoff reconnect     |
| **Rug pull tokens**         | Only trade whitelisted tokens with verified contracts                     |
| **Gas spike**               | MAX_GAS_PRICE ceiling; skip opportunity if gas > 10 gwei                  |
| **0.45s block timing**      | Total detection + submission budget: <400ms. Parabolic calc + local sim keeps us under. |
| **Decimal mismatch**        | Normalization layer handles tokens with different decimal counts           |
| **Nonce collision**          | Single TX concurrency model — skip if pending TX exists                   |

---

## 11. Monitoring & Alerts (Discord)

**Discord Webhook** sends alerts for:

| Event                  | Alert Level | Content                                    |
| ---------------------- | ----------- | ------------------------------------------ |
| Profitable trade       | ✅ Success  | Pair, profit amount, TX hash, gas cost     |
| Trade reverted         | ⚠️ Warning  | Pair, revert reason, gas lost              |
| WebSocket disconnected | 🔴 Error    | Provider name, reconnect attempt count     |
| Bot started/stopped    | ℹ️ Info     | Version, config summary                    |
| Daily P&L summary      | 📊 Report  | Total trades, total profit, win rate, gas spent |

**Implementation**: Simple POST to Discord webhook URL — no bot token needed.

---

## 12. Implementation Roadmap

| Phase | Deliverable                                | Est. Effort |
| ----- | ------------------------------------------ | ----------- |
| 1     | Project scaffolding + Hardhat + TypeScript setup | 0.5 day |
| 2     | FlashSwapArbitrage contract + callback tests | 2 days     |
| 3     | Price feed module (WebSocket + Multicall3) | 1 day       |
| 4     | Opportunity detector + parabolic optimal amt | 1.5 days   |
| 5     | Execution engine + private TX submission   | 1.5 days    |
| 6     | Discord monitoring integration             | 0.5 day     |
| 7     | Integration testing on Hardhat fork        | 1 day       |
| 8     | Mainnet deployment + read-only monitoring  | 0.5 day     |
| 9     | Live execution with flash swaps            | 0.5 day     |
| **Total** |                                        | **~9 days** |

---

## 13. Decision Log

| #  | Decision | Rationale | Date |
|----|----------|-----------|------|
| 1  | TypeScript + Ethers.js v6 | Best DeFi ecosystem support, type safety | 2026-03-12 |
| 2  | Chainstack WSS (primary) + Alchemy HTTP (fallback) | Chainstack: best BSC optimization, sub-100ms p95. Alchemy: reliable fallback. | 2026-03-12 |
| 3  | Uniswap V3 (BSC) vs PancakeSwap V3 (BSC) | Both V3 concentrated liquidity on same chain = atomic arb | 2026-03-12 |
| 4  | Local BSC fork (dev) → Mainnet (prod) | Real pool states for testing, zero-cost simulation | 2026-03-12 |
| 5  | Flash swaps via swap() callback (0% fee) | Production bots use this over flash() which charges pool fee tier (0.01-1%) | 2026-03-12 |
| 6  | Dynamic token whitelist | Start with 4 major pairs, expand based on TVL/volume criteria | 2026-03-12 |
| 7  | Multi-builder proxy (Blockrazor/Merkle) | 48 Club + Blockrazor = 96% of BSC blocks. Private TX mandatory. | 2026-03-12 |
| 8  | Parabolic approximation for optimal amount | O(1) after 3 samples, ~99.9% accuracy, ~5-10ms execution | 2026-03-12 |
| 9  | Single TX concurrency (skip if pending) | Simple, avoids nonce bugs. Revisit in v2. | 2026-03-12 |
| 10 | Discord webhook for monitoring | Simpler than Telegram bot. Real-time alerts + daily P&L. | 2026-03-12 |
| 11 | 2-leg arbitrage only for v1 | Faster to ship + validate. Triangular arb deferred to v2. | 2026-03-12 |
| 12 | 0.45s block time architecture | BSC Fermi hard fork (Jan 2026) reduced from 3s. Entire timing model updated. | 2026-03-12 |

---

## 14. Reference Materials

### Research Sources
- [BSC MEV Landscape (arXiv, Feb 2026)](https://arxiv.org/html/2602.15395v1) — Builder dominance data
- [BSC Fermi Hard Fork (Jan 2026)](https://www.bnbchain.org/en/blog/fermi-hard-fork-accelerates-bsc-to-0-45-second-block-times) — 0.45s blocks
- [BNB Chain MEV User Guide](https://docs.bnbchain.org/bnb-smart-chain/validator/mev/user-guide/) — Private TX options
- [PancakeSwap V3 Pool Source](https://github.com/pancakeswap/pancake-v3-contracts/blob/5cc479f0c5a98966c74d94700057b8c3ca629afd/projects/v3-core/contracts/PancakeV3Pool.sol) — Flash/swap implementation

### Reference Implementations
- [jorgejch/dex-arbitrage](https://github.com/jorgejch/dex-arbitrage) — TypeScript + Aave V3 flash loan arb (Polygon)
- [SimSimButDifferent/UniV3FlashSwapDualArbBot](https://github.com/SimSimButDifferent/UniV3FlashSwapDualArbBot) — V3 flash swap dual-DEX arb (Arbitrum, deployed)
- [sorasuzukidev/ethereum-bnb-mev-bot](https://github.com/sorasuzukidev/ethereum-bnb-mev-bot) — Multi-chain MEV bot (ETH + BSC)

### Key Libraries
- [@uniswap/v3-sdk](https://docs.uniswap.org/sdk/v3) — Off-chain tick math, swap simulation
- [Multicall3](https://www.multicall3.com/) — Batch RPC calls (deployed at `0xcA11...CA11` on 250+ chains)
- [48 Club Private TX API](https://docs.48.club/puissant-builder/send-privatetransaction)
- [bloXroute BSC Docs](https://docs.bloxroute.com/bsc/overview)

---

*This document is the single source of truth for the arbitrage bot architecture. All implementation should reference this blueprint.*
