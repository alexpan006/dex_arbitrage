# Mainnet Checklist — Things to Be Aware Of Before Going Live

> **Last Updated**: March 16, 2026
> **Status**: Pre-deployment review document
> **Read this ENTIRELY before deploying or enabling live trading.**

---

## Table of Contents

1. [Configuration Alignment (Contract ↔ Bot)](#1-configuration-alignment-contract--bot)
2. [Environment Variables (.env)](#2-environment-variables-env)
3. [Wallet & Funds](#3-wallet--funds)
4. [Contract Deployment](#4-contract-deployment)
5. [DRY_RUN Monitoring Phase](#5-dry_run-monitoring-phase)
6. [Going Live (DRY_RUN=false)](#6-going-live-dry_runfalse)
7. [Known Limitations & Code Gaps](#7-known-limitations--code-gaps)
8. [Emergency Procedures](#8-emergency-procedures)
9. [Cost Reference](#9-cost-reference)

---

## 1. Configuration Alignment (Contract ↔ Bot)

### ⚠️ CRITICAL: Keep contract cap and bot cap logically aligned

There are **two borrow caps** — one on-chain and one in bot config.

| Parameter | Location | How it works |
|---|---|---|
| `maxBorrowAmount` (on-chain) | `FlashSwapArbitrage` storage | Set at deploy via `INITIAL_MAX_BORROW_AMOUNT`; can be updated later by owner via `setMaxBorrowAmount()` |
| `MAX_BORROW_AMOUNT_USD` (off-chain) | `.env` | Bot-side strategy cap in USD |

**What happens if they don't match:**
- On-chain cap < bot cap → contract reverts with `INVALID_AMOUNT`, gas wasted
- Bot cap < on-chain cap → bot is conservative (safe but might miss larger opportunities)

**Action required:**
- Set a conservative `INITIAL_MAX_BORROW_AMOUNT` at deployment
- Tune `MAX_BORROW_AMOUNT_USD` in `.env`
- If needed later, owner can update on-chain cap without redeploy: `setMaxBorrowAmount(newAmount)`

### Token Decimals Matter

`maxBorrowAmount` is token units with 18 decimals (e.g., `100000 ether` = 100,000 tokens for 18-decimal assets). This works correctly for:
- **18-decimal tokens**: WBNB (18), USDT (18 on BSC), USDC (18 on BSC), ETH (18)

If you add tokens with different decimals in the future, an 18-decimal cap can represent very different real amounts:
- 8-decimal token: `100000 ether` means an effectively huge token count
- All BSC stablecoins use 18 decimals, so this is not an issue currently

### Other Config Pairs to Keep Aligned

| Bot Config (.env) | What It Controls | Must Match With |
|---|---|---|
| `MIN_PROFIT_THRESHOLD_USD=0.50` | Minimum profit to attempt execution | Should be > gas cost (~$0.05–$2) |
| `MAX_GAS_PRICE_GWEI=10` | Skip opportunities if gas > this | Current BSC gas is 0.1–3 gwei; 10 is a safe cap |
| `FLASH_SWAP_ARBITRAGE_ADDRESS=` | Your deployed contract address | Must be set after deployment |
| `DRY_RUN=true` | Bot mode (monitor vs execute) | Must be explicitly set to `false` for live trading |

---

## 2. Environment Variables (.env)

### Must Update Before Mainnet

| Variable | Current Value | Action Needed |
|---|---|---|
| `PRIVATE_KEY` | `your_private_key_here` | ⚠️ **MUST** replace with your real wallet private key (64 hex chars, no 0x prefix) |
| `FLASH_SWAP_ARBITRAGE_ADDRESS` | _(empty)_ | Set after contract deployment |
| `BUILDER_48CLUB_URL` | `https://api.48.club/eth/v1/rpc` | ⚠️ **DEPRECATED** — change to `https://rpc.48.club` |
| `BUILDER_PROXY_URL` | `https://bsc-builder.blockrazor.xyz` | ⚠️ **VERIFY** — recommended: `https://hongkong.builder.blockrazor.io` |

### Verify Before Starting

| Variable | Expected Value | How to Verify |
|---|---|---|
| `CHAINSTACK_WSS_URL` | `wss://bsc-mainnet.core.chainstack.com/...` | Must start with `wss://` |
| `CHAINSTACK_HTTP_URL` | `https://bsc-mainnet.core.chainstack.com/...` | Must start with `https://` |
| `DISCORD_WEBHOOK_URL` | `https://discord.com/api/webhooks/...` | Send a test message to verify |
| `DRY_RUN` | `true` (default) | Must be explicitly `false` to enable live trades |

### Security Reminders

- **NEVER** commit `.env` to git (it's in `.gitignore`)
- **NEVER** share your `PRIVATE_KEY` with anyone
- **NEVER** use the Anvil default key (`0xac0974...`) on mainnet — anyone can drain it
- The bot validates `PRIVATE_KEY` format at startup, but cannot verify it's the right wallet
- Consider using a **dedicated bot wallet** separate from your main wallet

---

## 3. Wallet & Funds

### For DRY_RUN Monitoring (No Trades)

| Item | Amount Needed |
|---|---|
| BNB for contract deployment | **0.01 BNB** (~$6.50) — one-time |
| BNB for bot operations | **0 BNB** — DRY_RUN only reads chain state |

### For Live Trading (DRY_RUN=false)

| Item | Recommended Amount | Notes |
|---|---|---|
| BNB for gas | **0.5–2 BNB** ($325–$1,300) | Covers 500–2000 TX attempts |
| Token capital | **0** (flash swaps are borrowed & repaid atomically) | No capital at risk |

### How to Fund Your Bot Wallet

1. Generate or use an existing BSC wallet
2. Export the private key (64 hex chars, no `0x` prefix)
3. Send BNB from an exchange or another wallet to the bot wallet address
4. Verify balance on BscScan before proceeding

### Important: The Contract Holds No Funds

- The contract itself doesn't hold BNB or tokens during normal operation
- Flash swaps borrow, arb, and repay within a single transaction
- Any tokens accidentally sent to the contract can be recovered via `withdrawToken()` (owner-only)
- Any BNB accidentally sent can be recovered via `withdrawBNB(uint256 amount)` (owner-only)

---

## 4. Contract Deployment

### Pre-Deployment Checklist

- [ ] `PRIVATE_KEY` in `.env` is your real mainnet wallet key
- [ ] Wallet has at least 0.01 BNB for deployment gas
- [ ] Set `INITIAL_MAX_BORROW_AMOUNT` in `.env` (can be updated later on-chain via `setMaxBorrowAmount()`)
- [ ] Run `npx hardhat compile` — ensure zero errors
- [ ] Double-check constructor parameters match `src/config/constants.ts`:
  - Uniswap V3 Factory: `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7`
  - PancakeSwap V3 Deployer: `0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9`
  - Init code hashes match

### Deploy Command

```bash
npx hardhat run scripts/deploy.ts --network bsc
```

### Post-Deployment

1. Copy the deployed contract address from the output
2. Set it in `.env`: `FLASH_SWAP_ARBITRAGE_ADDRESS=0x...`
3. Verify on BscScan: `https://bscscan.com/address/0x...`
4. Confirm `owner()` matches your wallet address
5. Optionally verify source code on BscScan for transparency

### If Deployment Fails

- Check wallet BNB balance
- Check gas price isn't spiking
- Check RPC endpoint is responsive: `curl -X POST https://bsc-mainnet.core.chainstack.com/... -H "Content-Type: application/json" -d '{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}'`
- Hardhat config `gasPrice: 3_000_000_000` (3 gwei) is fine — BSC gas is currently ~0.1 gwei, so 3 gwei will confirm quickly

---

## 5. DRY_RUN Monitoring Phase

### What DRY_RUN=true Does

- ✅ Connects to BSC mainnet via WebSocket
- ✅ Discovers pool pairs (PancakeSwap V3 + Uniswap V3)
- ✅ Reads pool prices every block via multicall
- ✅ Detects arbitrage opportunities (spread detection)
- ✅ Runs borrow amount optimization (QuoterV2 quotes)
- ✅ Estimates gas cost
- ✅ Logs what it **would** execute
- ✅ Sends Discord notifications for detected opportunities
- ❌ Does NOT sign or send any transaction
- ❌ Does NOT spend any gas (beyond initial RPC calls, which are free)

### Start Command

```bash
DRY_RUN=true npx ts-node src/index.ts
```

### What to Monitor During DRY_RUN

| Metric | What to Look For | Concern If... |
|---|---|---|
| Opportunities detected / hour | Should see some within 1–24 hours | Zero after 24h → spreads may be too small for our pairs |
| Spread size (bps) | Typical: 1–20 bps | Always < 5 bps → may not be profitable after gas |
| Estimated profit per opp | Should exceed gas cost | Always < $0.50 → need larger borrow or different pairs |
| Quote failures | Some are normal (< 30%) | > 50% → QuoterV2 issues or RPC problems |
| WebSocket disconnects | Should be rare | Frequent → Chainstack WS stability issue |
| Pool count | Should match expected pairs | 0 pools → discovery config issue |

### How Long to Monitor

- **Minimum**: 24 hours (captures different trading activity periods)
- **Recommended**: 48–72 hours (captures weekday + weekend patterns)
- **What you're looking for**: Consistent opportunity flow, stable connections, no crashes

---

## 6. Going Live (DRY_RUN=false)

### Pre-Live Checklist

- [ ] DRY_RUN monitoring ran for 48+ hours without crashes
- [ ] Opportunities are being detected with sufficient profit margins
- [ ] Discord notifications are working
- [ ] Wallet has 0.5+ BNB for gas
- [ ] `FLASH_SWAP_ARBITRAGE_ADDRESS` is set and verified on BscScan
- [ ] `BUILDER_48CLUB_URL` updated to `https://rpc.48.club`
- [ ] `BUILDER_PROXY_URL` verified (recommend `https://hongkong.builder.blockrazor.io`)
- [ ] `MIN_PROFIT_THRESHOLD_USD` set appropriately (recommend starting at $2–$5)
- [ ] `MAX_GAS_PRICE_GWEI` set (recommend 10 gwei as ceiling)
- [ ] On-chain `maxBorrowAmount` and `.env` `MAX_BORROW_AMOUNT_USD` match your intended risk envelope

### Recommended Initial Live Settings

```env
DRY_RUN=false
MIN_PROFIT_THRESHOLD_USD=5.00      # Conservative — only take high-confidence arbs
MAX_BORROW_AMOUNT_USD=5000         # Start small — increase after validation
MAX_GAS_PRICE_GWEI=10              # Skip if gas spikes
```

### First Live Trade — What to Expect

1. Bot detects opportunity with profit > $5
2. Gas estimation confirms profitability after gas cost
3. TX signed and sent to 48 Club / Blockrazor (private TX)
4. If both builders fail, falls back to public RPC broadcast
5. TX included in next block (~0.45 seconds)
6. Either:
   - ✅ **Success**: Profit stays in contract, log shows amounts
   - ❌ **Revert**: `BELOW_MIN_PROFIT` (price moved) or `INSUFFICIENT_OUTPUT` (slippage). Gas spent but no fund loss.
7. Discord notification sent with result

### After First Trades

- Review success rate — expect 30–70% success initially
- Failed TXs are normal (prices move in 0.45s between detection and execution)
- Gradually lower `MIN_PROFIT_THRESHOLD_USD` if success rate is high
- Gradually increase `MAX_BORROW_AMOUNT_USD` as confidence grows
- Withdraw profits from contract periodically via `withdrawToken()`

---

## 7. Known Limitations & Code Gaps

### Must Fix Before Live Trading (Not Needed for DRY_RUN)

| Issue | Severity | Impact | File |
|---|---|---|---|
| No WebSocket reconnect | CRITICAL | Bot goes blind on WS disconnect — trades on stale data | `PriceFeed.ts` |
| Abrupt shutdown | CRITICAL | In-flight TX left unmonitored on Ctrl+C | `index.ts` |
| Concurrency lock not atomic | HIGH | Rare but possible double-submission | `ExecutionEngine.ts` |
| `zeroForOne` hardcoded `true` | HIGH | Misses ~50% of opportunities (token1→token0 direction) | `ExecutionEngine.ts` |
| No timeout on public RPC broadcast | HIGH | Bot can deadlock if Chainstack hangs | `PrivateTxSubmitter.ts` |
| Second-leg quote not validated | HIGH | Can produce invalid TX params → gas wasted | `OpportunityDetector.ts` |

### Safe for DRY_RUN Mode (Fix Before Live)

All above issues are **irrelevant in DRY_RUN mode** because no transactions are sent. You can safely deploy and monitor with `DRY_RUN=true` while these are being fixed.

### Design Limitations (Not Bugs)

| Limitation | Impact | Mitigation |
|---|---|---|
| 2-leg arbitrage only | Cannot do triangular arb (A→B→C→A) | By design for v1 — simpler, safer |
| Single TX concurrency | Skips new opps while TX pending | By design — prevents nonce conflicts |
| Whitelist-only pool discovery | Only monitors configured token pairs | Add more pairs to `src/config/tokens.ts` as needed |
| No auto-restart | Bot stays down after crash | Use PM2 or systemd for production |

---

## 8. Emergency Procedures

### Stop the Bot

```bash
# Graceful (sends Discord shutdown notification)
Ctrl+C

# Force kill (if graceful fails)
kill -9 $(pgrep -f "ts-node src/index.ts")
```

### Pause the Contract (Blocks All Executions)

If you suspect the bot is executing bad trades, pause the contract directly:

```javascript
// Using ethers.js or hardhat console
const contract = await ethers.getContractAt("FlashSwapArbitrage", "0xYOUR_CONTRACT_ADDRESS");
await contract.setPaused(true);
```

### Withdraw Funds from Contract

```javascript
// Withdraw specific token (e.g., USDT profits)
await contract.withdrawToken("0x55d398326f99059fF775485246999027B3197955", amount);

// Withdraw BNB
await contract.withdrawBNB(amount);
```

### If You Suspect a Compromised Private Key

1. **Immediately** pause the contract: `contract.setPaused(true)`
2. Withdraw all tokens from the contract to a safe address
3. Stop the bot
4. Generate a new wallet and redeploy the contract

---

## 9. Cost Reference

### Gas Costs (March 2026 BSC)

| Operation | Gas Used | Cost @ 0.1 gwei | Cost @ 3 gwei | Cost @ 10 gwei |
|---|---|---|---|---|
| Contract deployment | ~1.5M | $0.10 | $2.93 | $9.75 |
| Arbitrage TX (success) | ~400K | $0.03 | $0.78 | $2.60 |
| Arbitrage TX (revert) | ~200K | $0.01 | $0.39 | $1.30 |
| Read-only operations (DRY_RUN) | 0 | $0 | $0 | $0 |

### Monthly Operational Costs

| Scenario | Chainstack RPC | Gas | Total |
|---|---|---|---|
| **DRY_RUN only** | $0 (free tier) | $0 | **$0/mo** |
| **Light trading** (10 arbs/day) | $0–$49 | ~$25–$80 | **$25–$130/mo** |
| **Active trading** (30 arbs/day) | $49 | ~$75–$240 | **$125–$290/mo** |

### BNB Price Reference

- Current: ~$650 (March 2026)
- 0.01 BNB ≈ $6.50
- 0.1 BNB ≈ $65
- 1 BNB ≈ $650

---

## Quick Start Summary

```bash
# 1. Update .env with real private key and fix deprecated URLs
# 2. Fund wallet with 0.01+ BNB
# 3. Deploy contract
npx hardhat run scripts/deploy.ts --network bsc
# 4. Set FLASH_SWAP_ARBITRAGE_ADDRESS in .env
# 5. Start monitoring
DRY_RUN=true npx ts-node src/index.ts
# 6. After 48h+ of stable monitoring, enable live trading
DRY_RUN=false npx ts-node src/index.ts
```
