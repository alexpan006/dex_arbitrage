# BSC V3 Pool Candidate Research

> **Date**: 2026-03-28  
> **Block**: 89271331  
> **Scanner Script**: `scripts/scan-candidate-pools.ts`  
> **Raw Data**: `data/pool-scan-results.json`

---

## Executive Summary

We scanned **1,155 pair+fee combinations** (37 tokens × 7 base tokens × 5 fee tiers) across both Uniswap V3 and PancakeSwap V3 factory contracts on BSC mainnet.

| Metric | Count |
|--------|-------|
| Total scanned | 1,155 |
| Pools on BOTH DEXes | 37 |
| Viable (non-zero liquidity) | 21 |
| Currently above spread threshold | 1 (ETH/USDT fee-100) |
| Unique viable pairs | 9 |
| Non-blue-chip pairs on both DEXes | **0** |

**Key Finding**: Uniswap V3 adoption on BSC is extremely limited. Only blue-chip pairs (WBNB, USDT, USDC, BTCB, ETH, BUSD) exist on both DEXes. No mid-tier tokens (CAKE, LINK, SOL, etc.), no meme tokens, no DeFi natives, and no LSTs had pools on both Uniswap V3 and PancakeSwap V3 simultaneously.

---

## 1. On-Chain Scan Results

### 1.1 All Viable Pairs (21 pools across 9 pairs)

| Pair | Fee Tiers | Max Spread (bps) | Best Opportunity |
|------|-----------|------------------|------------------|
| **ETH/WBNB** | 500, 10000 | 129.34 | fee-10000 has wide spread but 201 bps threshold |
| **USDT/BTCB** | 500, 10000 | 108.02 | fee-10000 has wide spread but 201 bps threshold |
| **WBNB/BUSD** | 100, 500, 10000 | 57.04 | fee-10000 moderate spread, far below threshold |
| **USDT/USDC** | 100, 500, 10000 | 32.44 | Stablecoin pair — depeg arb potential |
| **USDC/WBNB** | 100, 500, 10000 | 26.32 | fee-10000 spread, but threshold is 201 bps |
| **USDT/WBNB** | 100, 500, 10000 | 11.41 | fee-10000 spread, threshold 201 bps |
| **ETH/USDT** | 100, 500 | 7.03 | **fee-100 above threshold (3 bps)** ✅ |
| **USDT/BUSD** | 100, 500 | 1.52 | Stablecoin pair — low spread |
| **BTCB/WBNB** | 500 | 0.68 | Only fee-500 viable, well below threshold |

### 1.2 Currently Above Threshold

Only **1 pair** had a spread above its dynamic threshold at scan time:

| Pair | Fee | Spread | Threshold | Edge |
|------|-----|--------|-----------|------|
| ETH/USDT | 100 | 7.03 bps | 3 bps | +4.03 bps |

**However**, from our earlier smoke test analysis, even ETH/USDT fee-100 with similar spreads resulted in net losses once price impact was included. The marginal spread ≠ profitable trade size.

### 1.3 Non-Viable Pools (exist on both but zero/dust liquidity)

| Pair | Fee | Issue |
|------|-----|-------|
| BTCB/WBNB | 100 | Zero liquidity on one side |
| BTCB/WBNB | 10000 | Zero liquidity on one side |
| ETH/WBNB | 100 | Zero liquidity on one side |
| WBNB/FDUSD | 10000 | Zero liquidity |
| USDT/BTCB | 100 | Zero liquidity |
| ETH/USDT | 10000 | Zero liquidity |
| USDT/BUSD | 10000 | Zero liquidity |
| USDT/FDUSD | 100, 10000 | Zero liquidity |
| BTCB/USDC | 100, 500 | Zero liquidity |
| USDC/BUSD | 100, 500 | Pool state unreadable |
| ETH/USDC | 100, 500 | Pool state unreadable |
| ETH/wstETH | 100 | Pool state unreadable |

### 1.4 Fee Tier Analysis

| Fee Tier | Pools on Both | Viable | Threshold (same-fee) | Observation |
|----------|--------------|--------|---------------------|-------------|
| 100 (0.01%) | 15 | 8 | 3 bps | Best chance — lowest threshold |
| 500 (0.05%) | 12 | 9 | 11 bps | Good liquidity but spreads rarely reach 11 bps |
| 2500 (0.25%) | 0 | 0 | 51 bps | **No viable pools at this tier** |
| 3000 (0.30%) | 0 | 0 | 61 bps | Not used on BSC V3 |
| 10000 (1.0%) | 10 | 6 | 201 bps | Wide spreads exist but threshold too high |

**Key insight**: Fee-2500 (PancakeSwap's medium tier) has no pools on both DEXes. Fee-3000 (Uniswap's medium tier) likewise empty. The fee-10000 tier shows the widest spreads but the 201 bps threshold makes them unprofitable for same-fee arb.

### 1.5 Cross-Fee Tier Opportunity

One strategy not yet implemented: arb across **different fee tiers**. Example:
- Borrow from PCS fee-500 pool, sell into Uni fee-100 pool (or vice versa)
- Threshold would be `(500 + 100) / 100 + 1 = 7 bps` instead of `11 bps`
- This opens up more combinations but adds implementation complexity

---

## 2. Liquidity Analysis

### 2.1 Deepest Pools (by raw liquidity — higher = less price impact)

**PancakeSwap V3** dominates liquidity on nearly every pair:

| Pair | Fee | PCS Liquidity | Uni Liquidity | PCS/Uni Ratio |
|------|-----|--------------|--------------|---------------|
| USDT/USDC | 100 | 19,884×10¹⁸ | 650×10¹⁸ | 30:1 |
| USDT/WBNB | 500 | 457×10¹⁸ | 345×10¹⁸ | 1.3:1 |
| USDT/BTCB | 500 | 353×10¹⁸ | 17×10¹⁸ | 20:1 |
| USDT/BUSD | 100 | 213×10¹⁸ | 111×10¹⁸ | 1.9:1 |
| ETH/USDT | 500 | 158×10¹⁸ | 17×10¹⁸ | 9:1 |
| ETH/USDT | 100 | 76×10¹⁸ | 38×10¹⁸ | 2:1 |
| ETH/WBNB | 500 | 73×10¹⁸ | 4.8×10¹⁸ | 15:1 |

**Implication**: The weaker side (usually Uniswap V3) limits practical borrow size. Even if spread exists, low Uni liquidity means any reasonable trade size causes massive price impact.

### 2.2 Liquidity Asymmetry Problem

For profitable arb, we need the **borrow pool** to have enough liquidity that we don't move its price significantly. The scanner shows Uniswap V3 consistently has 2x–30x less liquidity than PancakeSwap. This means:
- Borrowing from Uni → limited by low liquidity → small trade sizes → small profits
- Borrowing from PCS → more available but PCS spread might already be tight

---

## 3. Background Research Findings

### 3.1 BSC DEX Landscape (from librarian research)

- **PancakeSwap V3** is the dominant BSC DEX: ~$438M daily volume
- **Uniswap V3** on BSC has significantly lower volume and adoption
- Only **1,236 of ~15,187 Uniswap V3 BSC pairs** have meaningful liquidity
- Most BSC users default to PancakeSwap (native ecosystem advantage)
- **THENA V3** (formerly Algebra-based) is a growing BSC DEX with concentrated liquidity
- **Biswap V3** also present but smaller

### 3.2 Why Our Current Pairs Aren't Profitable

From spread/profit analysis during live testing:
1. **Price impact dominates**: Even 5 bps marginal spread loses money at any practical trade size
2. **Competition**: These blue-chip pairs are the most arbitraged on BSC — MEV bots keep spreads razor-thin
3. **Fee floor**: fee-100 pairs need 3 bps spread minimum, fee-500 needs 11 bps — rarely reached on liquid pairs
4. **Block time**: BSC 0.45s blocks mean prices converge very fast

### 3.3 Strategy Recommendations from Research

1. **Expand to BUSD pairs** — BUSD still has pools on both DEXes with decent liquidity
2. **Cross-fee arb** — Borrow from fee-500, sell into fee-100 (lower combined threshold)
3. **Add BTCB pairs** — BTCB/WBNB fee-500 and BTCB/USDT fee-500 have decent liquidity
4. **Consider other DEXes**: THENA V3, Biswap V3 alongside PancakeSwap V3 (PCS vs THENA instead of PCS vs Uni)
5. **Stablecoin depeg events** — USDT/USDC fee-100 has massive liquidity; during stress events, spreads widen
6. **Fee-10000 tier** — Shows widest natural spreads but threshold is too high for same-fee arb; useful only for cross-fee

---

## 4. Recommended Whitelist Update

### 4.1 Current Whitelist (4 pairs, 8 pool combinations)
```
WBNB/USDT  fees: [100, 500, 2500]
WBNB/USDC  fees: [500, 2500]
ETH/USDT   fees: [500, 2500]
ETH/WBNB   fees: [500, 2500]
```

**Problem**: fee-2500 pools don't exist on both DEXes! Scanner found zero viable fee-2500 pools. We're wasting cycles scanning non-existent pools.

### 4.2 Proposed Whitelist (9 pairs, 21 pool combinations)

```typescript
// ── Tier 1: Best candidates (fee-100 pairs — lowest threshold) ──
{ token0Symbol: "WBNB", token1Symbol: "USDT",  feeTiers: [100, 500] },
{ token0Symbol: "WBNB", token1Symbol: "USDC",  feeTiers: [100, 500] },
{ token0Symbol: "ETH",  token1Symbol: "USDT",  feeTiers: [100, 500] },
{ token0Symbol: "WBNB", token1Symbol: "BUSD",  feeTiers: [100, 500] },
{ token0Symbol: "USDT", token1Symbol: "USDC",  feeTiers: [100, 500] },
{ token0Symbol: "USDT", token1Symbol: "BUSD",  feeTiers: [100, 500] },

// ── Tier 2: Fee-500 only (higher threshold, moderate chance) ──
{ token0Symbol: "BTCB", token1Symbol: "WBNB",  feeTiers: [500] },
{ token0Symbol: "ETH",  token1Symbol: "WBNB",  feeTiers: [500] },
{ token0Symbol: "USDT", token1Symbol: "BTCB",  feeTiers: [500] },
```

### 4.3 New Tokens Needed

Add to `src/config/tokens.ts`:
```typescript
BTCB: {
  symbol: "BTCB",
  address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
  decimals: 18,
},
BUSD: {
  symbol: "BUSD",
  address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
  decimals: 18,
},
```

### 4.4 Fee Tier Changes

- **Remove fee-2500**: No viable pools exist at this tier on both DEXes
- **Add fee-100**: Best candidates are at this tier (lowest threshold = 3 bps)
- **Keep fee-500**: Decent liquidity, threshold 11 bps, sometimes reachable
- **Skip fee-10000 for now**: Threshold 201 bps too high for same-fee arb
- **Skip fee-3000**: Not used on BSC

---

## 5. Realistic Profitability Assessment

### 5.1 The Hard Truth

Based on our analysis, **Uniswap V3 vs PancakeSwap V3 arbitrage on BSC blue-chip pairs is extremely competitive and likely unprofitable** at current market conditions:

- Spreads on liquid pairs rarely exceed the fee floor
- When they do (2-7 bps above threshold), price impact at any practical size exceeds the edge
- MEV competition on BSC keeps spreads tight (0.45s block times help convergence)
- Uniswap V3's low BSC adoption limits the number of arb surfaces

### 5.2 Where Opportunity May Exist

1. **Volatility events**: Large market moves, liquidation cascades, bridge congestion
   - During these events, arb bot operators who are already running and indexed will capture the first opportunities
   - Being live and monitoring 24/7 means catching the rare profitable windows

2. **Stablecoin stress**: USDT/USDC or USDT/BUSD depeg events
   - USDT/USDC fee-100 has enormous liquidity on both DEXes
   - Even small depeg events (5-10 bps) could be profitable
   - These events are rare but lucrative

3. **Cross-fee tier arb** (not yet implemented):
   - Borrow from fee-500 pool, sell into fee-100 pool
   - Lower combined threshold: `(500 + 100) / 100 + 1 = 7 bps`
   - More combinations possible

4. **Multi-DEX expansion** (future):
   - Add THENA V3, Biswap V3 as additional DEXes
   - PCS vs THENA might have wider spreads than PCS vs Uni
   - Different arbitrageur competition landscape

### 5.3 Expected Profit Profile

| Scenario | Frequency | Expected Profit/Trade |
|----------|-----------|----------------------|
| Normal market (current) | 99% of time | $0 (no qualifying spreads) |
| Minor volatility spike | ~5-10x/day | $0.01-0.10 (marginal after gas) |
| Major event (crash, depeg) | ~1-5x/month | $1-50+ per opportunity |
| Black swan (flash crash, depeg) | ~1-5x/year | $50-500+ per opportunity |

**Strategy**: Run the bot 24/7 with minimal cost (free RPC tier, low-resource server). The goal is to be ready when rare profitable events occur, not to profit on every block.

---

## 6. Next Steps

### Immediate (before going live with expanded whitelist)
- [ ] Add BTCB and BUSD to `src/config/tokens.ts`
- [ ] Update `INITIAL_PAIRS` in `src/config/pools.ts` per Section 4.2
- [ ] Remove fee-2500 from all pair configs (non-existent pools)
- [ ] Add fee-100 to WBNB/USDC, ETH/USDT pairs
- [ ] Run spread monitoring script on expanded whitelist for 24h
- [ ] Analyze spread frequency data to confirm findings

### Short-term (1-2 weeks)
- [ ] Implement cross-fee tier arb (borrow from fee-X, sell into fee-Y)
- [ ] Add event-based alerting for stablecoin depeg (USDT/USDC spread > 10 bps)
- [ ] Run bot 24/7 on expanded whitelist, collect telemetry

### Medium-term (1-2 months)
- [ ] Research THENA V3 and Biswap V3 factory/pool contracts
- [ ] Add multi-DEX support (not just Uni vs PCS)
- [ ] Consider off-chain V3 simulation for sub-block latency
- [ ] Evaluate paid RPC tier if opportunity frequency justifies cost

---

## 7. Token Address Reference

All verified BSC mainnet addresses used in the scan:

| Symbol | Address | Decimals | Tier |
|--------|---------|----------|------|
| WBNB | 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c | 18 | blue-chip |
| USDT | 0x55d398326f99059fF775485246999027B3197955 | 18 | blue-chip |
| USDC | 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d | 18 | blue-chip |
| BTCB | 0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c | 18 | blue-chip |
| ETH | 0x2170Ed0880ac9A755fd29B2688956BD959F933F8 | 18 | blue-chip |
| BUSD | 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56 | 18 | blue-chip |
| FDUSD | 0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409 | 18 | stablecoin |

*Note: Only blue-chip tokens had pools on both Uniswap V3 and PancakeSwap V3. All mid-tier (CAKE, LINK, SOL, etc.), DeFi native (XVS, ALPACA), meme (FLOKI, SHIB), and LST (stkBNB, BNBx) tokens had zero presence on Uniswap V3 BSC.*

---

## Appendix A: Scanner Script

See `scripts/scan-candidate-pools.ts` — queries both factory contracts for 37 tokens × 7 base tokens × 5 fee tiers.

## Appendix B: Fee Floor Math

For same-fee arb (borrow and sell in same fee tier):
```
minSpreadBps = (fee_poolA + fee_poolB) / 100 + SPREAD_DIFF_BPS
             = (fee + fee) / 100 + 1
             = 2 * fee / 100 + 1
```

| Fee Tier | Fee Floor (bps) | Min Spread (bps) |
|----------|----------------|-------------------|
| 100 | 2 | 3 |
| 500 | 10 | 11 |
| 2500 | 50 | 51 |
| 10000 | 200 | 201 |

For cross-fee arb (e.g. borrow from fee-500, sell into fee-100):
```
minSpreadBps = (500 + 100) / 100 + 1 = 7 bps
```

---

## Appendix C: Live Spread Monitor Results (2-minute sample)

> **Script**: `scripts/monitor-spreads.ts`  
> **Duration**: 2 minutes, 96 polls, 2016 total samples  
> **RPC errors**: 0  

### Above-Threshold Events: 42 in 2 minutes

| Pair | Events | % of Samples | Max Spread (bps) | Threshold (bps) |
|------|--------|-------------|-------------------|-----------------|
| WBNB/BUSD-100 | 19 | 19.8% | 4.85 | 3 |
| USDC/WBNB-100 | 15 | 15.6% | 4.27 | 3 |
| ETH/USDT-100 | 7 | 7.3% | 3.56 | 3 |
| USDT/WBNB-100 | 1 | 1.0% | 3.05 | 3 |

### Full Spread Distribution

| Pair | Min | Max | Avg | Median | P95 | Threshold | Above% |
|------|-----|-----|-----|--------|-----|-----------|--------|
| **WBNB/BUSD-100** | 0.76 | 4.85 | 1.80 | 1.37 | 4.85 | 3 | **19.8%** |
| **USDC/WBNB-100** | 0.30 | 4.27 | 1.67 | 0.94 | 4.22 | 3 | **15.6%** |
| **ETH/USDT-100** | 1.40 | 3.56 | 1.97 | 1.57 | 3.56 | 3 | **7.3%** |
| USDT/WBNB-100 | 0.01 | 3.05 | 0.64 | 0.35 | 1.43 | 3 | 1.0% |
| WBNB/BUSD-500 | 4.33 | 6.52 | 5.82 | 5.85 | 6.52 | 11 | 0.0% |
| USDT/USDC-500 | 1.53 | 1.53 | 1.53 | 1.53 | 1.53 | 11 | 0.0% |
| USDT/BUSD-500 | 1.52 | 1.52 | 1.52 | 1.52 | 1.52 | 11 | 0.0% |
| All fee-10000 pairs | stale | stale | stale | stale | stale | 201 | 0.0% |

### Key Observations

1. **Fee-100 pools are the only ones that cross threshold** — all 42 events came from fee-100 pairs
2. **WBNB/BUSD-100 is a NEW discovery** — not in current whitelist, but shows 19.8% above-threshold rate
3. **Fee-10000 pools are completely stale** — prices never changed in 2 minutes (low/no trading activity)
4. **Fee-500 pools barely move** — WBNB/BUSD-500 has 5.82 bps avg spread but threshold is 11 bps
5. **Spread persistence**: Above-threshold events often appear in consecutive polls (5-19 polls), suggesting slow arb correction — potential for capture if bot is fast enough

### Caveat
These are **marginal price spreads** (zero-size quotes). From our earlier profit analysis, even 5 bps spread on fee-100 pairs resulted in net losses after price impact at practical trade sizes. The monitor confirms opportunity *frequency* but not *profitability*.

---

## Appendix D: Expanded Scan — Round 2 (44 tokens, 2026-03-29)

> **Date**: 2026-03-29
> **Block**: 89380899
> **Tokens scanned**: 44 (original 37 + 7 new candidates from web research)
> **Total combinations**: 1,400

### D.1 New Tokens Added

Based on GeckoTerminal, CoinGecko, CoinMarketCap DEXScan, and DeFiLlama research, we added 7 new tokens suspected to have cross-DEX V3 presence:

| Symbol | Address | Source | Why Added |
|--------|---------|--------|-----------|
| RIVER | 0xdA7AD9dea9397cffdDAE2F8a052B82f1484252B3 | GeckoTerminal | Price divergence spotted between DEXes |
| SIREN | 0x997A58129890bBdA032231A52eD1ddC845fc18e1 | GeckoTerminal | BSC meme coin, massive spread reported |
| ANKR | 0xf307910A4c7bbc79691fD374889b36d8531B08e3 | CoinMarketCap | Uni V3 BSC pool confirmed |
| FET | 0x031b41e504677879370e9DBcF937283A8691Fa7f | CoinMarketCap | Uni V3 FET/WBNB pool confirmed |
| STG | 0xB0D502E938ed5f4df2E681fE6E419ff29631d62b | Stargate/DeFiLlama | Cross-chain bridge token |
| PENDLE | 0xb3Ed0A426155B79B898849803E3B36552f7ED507 | BSCScan | Yield protocol, BSC deployment |
| WOO | 0x4691937a7508860F876c9c0a2a617E7d9E945D4B | BSCScan | DEX infrastructure token |

### D.2 Expanded Scan Results

| Metric | Round 1 (37 tokens) | Round 2 (44 tokens) | Delta |
|--------|---------------------|---------------------|-------|
| Total scanned | 1,155 | 1,400 | +245 |
| Pools on BOTH DEXes | 37 | 38 | **+1** |
| Viable (non-zero liq) | 21 | 22 | **+1** |
| Unique viable pairs | 9 | 10 | **+1** |
| Non-blue-chip viable | 0 | **1** | **+1** |

### D.3 New Findings

**One new viable pair discovered**: **LTC/USDC fee-10000** (41.31 bps spread, 201 bps threshold — not profitable for same-fee arb but confirms LTC has cross-DEX presence).

**One new pool detected (non-viable)**: **USDT/SIREN fee-10000** — exists on both DEXes but pool state unreadable (likely too new or very low liquidity).

**All other new tokens (RIVER, ANKR, FET, STG, PENDLE, WOO)**: Zero pools found on both DEXes. These tokens may have pools on PancakeSwap V3 but **not** on Uniswap V3 BSC, confirming the pattern: Uniswap V3 on BSC is limited to blue-chips + a handful of major alts.

### D.4 Updated Viable Pairs (10 pairs, Round 2)

| # | Pair | Fee Tiers | Max Spread (bps) | Status |
|---|------|-----------|------------------|--------|
| 1 | USDT/WBNB | 100, 500, 10000 | 8.52 | Existing |
| 2 | USDC/WBNB | 100, 500, 10000 | 26.32 | Existing |
| 3 | BTCB/WBNB | 500 | 0.58 | Existing |
| 4 | ETH/WBNB | 500, 10000 | 129.34 | Existing |
| 5 | WBNB/BUSD | 100, 500, 10000 | 57.04 | Existing |
| 6 | USDT/USDC | 100, 500, 10000 | 32.44 | Existing |
| 7 | USDT/BTCB | 500, 10000 | 47.78 | Existing |
| 8 | ETH/USDT | 100, 500 | 2.51 | Existing |
| 9 | USDT/BUSD | 100, 500 | 1.49 | Existing |
| 10 | **LTC/USDC** | 10000 | 41.31 | **🆕 NEW** |

### D.5 Conclusion

**Adding 7 non-blue-chip tokens yielded only 1 new marginal pair (LTC/USDC at fee-10000).** This conclusively confirms:

1. **Uniswap V3 on BSC is almost exclusively blue-chip** — even high-profile tokens like CAKE, LINK, FET, ANKR, STG have no meaningful Uni V3 BSC pools alongside PCS V3
2. **The Uni V3 × PCS V3 opportunity set is capped at ~10 pairs** — we've likely found them all
3. **To expand beyond this, we must pivot to a different DEX pairing** (see Appendix E)

### D.6 SIREN Note

SIREN was flagged by GeckoTerminal as having massive price divergence between DEXes (+2.5% PCS vs +20.5% Uni). The scanner found a USDT/SIREN fee-10000 pool on both DEXes but it was unreadable — likely too low liquidity or too new. This token is worth monitoring but not viable for our flash-swap strategy due to insufficient pool depth.

---

## Appendix E: Future Opportunity — THENA V3 (Algebra) Integration

> **Status**: Research complete, implementation deferred
> **Priority**: HIGH — potentially 5-10x more token pairs than Uni V3

### E.1 Why THENA V3?

| Metric | Uniswap V3 BSC | THENA (Algebra) BSC |
|--------|----------------|---------------------|
| TVL | ~$114M | ~$5.36M |
| Viable overlap with PCS V3 | 10 pairs (blue-chip only) | Est. 50-100+ pairs |
| Token diversity | Blue-chip only | Blue-chip + mid-cap |
| Interface | `slot0()` | `globalState()` |
| Fee model | Fixed tiers | Dynamic |
| Factory | `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7` | `0x306F06C147f064A010530292A1EB6737c3e378e4` |

The 45:1 TVL ratio (PCS vs THENA) creates natural price inefficiencies — exactly what we need for arbitrage.

### E.2 Technical Changes Required

1. **Pool discovery**: THENA uses `factory.poolByPair(token0, token1)` instead of `factory.getPool(token0, token1, fee)` — no fee tier parameter (dynamic fees)
2. **Price reading**: `globalState()` instead of `slot0()` — same `sqrtPriceX96` and `tick` fields, different method name
3. **Fee handling**: THENA fees are dynamic (returned by `globalState().fee`), not fixed tiers — threshold calculation must use actual fee at query time
4. **Flash swap contract**: May need a separate contract or adapter since THENA pools use Algebra's flash interface, not Uniswap V3's

### E.3 Other V3 DEXes Investigated (Not Viable)

| DEX | Status | Why Not |
|-----|--------|---------|
| KyberSwap Elastic | ❌ Dead | $1,633 TVL, hacked Nov 2023 |
| Biswap V3 | ❌ No V3 | Only V2-style AMM |
| Nile Exchange | ❌ Wrong chain | Linea, not BSC |
| iZiSwap | ⚠️ Very small | Minimal BSC presence |

### E.4 Implementation Estimate

- **Effort**: 1-2 weeks
- **Risk**: Medium (THENA had a related exploit in March 2026 via Venus Protocol)
- **Reward**: Potentially 5-10x more arb pairs, access to mid-cap tokens with wider spreads

---

## Appendix F: Round 3 — CoinGecko Cross-Reference Scan

> **Date**: 2026-03-29
> **Block**: 89394876
> **Tokens**: 51 (44 from round 2 + 7 CoinGecko-discovered)
> **Combinations scanned**: 1,645

### F.1 Methodology

Scraped CoinGecko's exchange pages for PancakeSwap V3 BSC and Uniswap V3 BSC using Playwright MCP (50 pairs each, sorted by 24h volume). Extracted token addresses from swap links and cross-referenced overlapping pairs.

**CoinGecko data (scraped 2026-03-29):**
- PCS V3 BSC: 730 coins, $346M 24h volume
- Uni V3 BSC: 205 coins, $420M 24h volume (but QUQ alone = 91.67%)

### F.2 New Tokens Added

| Token | Address | CoinGecko Volume | Note |
|-------|---------|-------------------|------|
| KOGE | `0xe6DF05CE8C8301223373CF5B969AFCb1498c5528` | $10.2M PCS + $10.1M Uni | High on both |
| WMTX | `0xdbB5cf12408A3ac17D668037Ce289F9Ea75439d7` | $10.8M PCS + $8.1M Uni | World Mobile Token |
| USD1 | `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` | $4.1M PCS | WLFI stablecoin |
| BAS | `0x0f0Df6Cb17ee5e883EDdFEf9153fc6036Bdb4e37` | $5M PCS | BNB Attestation Service |
| QUQ | `0x4Fa7c69a7b69F8BC48233024D546bC299d6b03bf` | $385M Uni | Suspicious — 91.67% of Uni V3 vol |
| DUCKY | `0xaDd50D6A3F931e5B4A14D06A4a77FE71171A462f` | $648K Uni | Meme |
| ASTER | `0x000ae314e2A2172a039B26378814c252734f556a` | Uni V3 only | Mid-cap |

### F.3 Scan Results

**None of the CoinGecko-discovered tokens had pools on both Uni V3 and PCS V3.** This confirms:
- CoinGecko's "volume" figures include pools that exist on only ONE DEX
- Tokens like KOGE and WMTX have high volume on each DEX individually but use different pool pairs
- Uniswap V3 BSC remains limited to blue-chip pairs for cross-DEX arbitrage

### F.4 New Viable Pairs Found (vs Round 2)

Two new pairs emerged with viable liquidity on both DEXes (missed in round 2 due to token count):

| Pair | Fee Tiers | Max Spread | Notes |
|------|-----------|------------|-------|
| **ETH/USDC** | 100, 500 | 28.60 bps | NEW — fee-100 currently above threshold |
| **USDC/BUSD** | 100, 500 | 12.35 bps | NEW — fee-500 currently above threshold |

### F.5 Updated Viable Pair Summary (11 total)

| # | Pair | Fee Tiers | Max Spread | Round |
|---|------|-----------|------------|-------|
| 1 | USDT/WBNB | 100, 500, 10000 | 8.66 bps | R1 |
| 2 | USDC/WBNB | 100, 500, 10000 | 26.32 bps | R1 |
| 3 | BTCB/WBNB | 500 | 0.03 bps | R1 |
| 4 | ETH/WBNB | 500, 10000 | 129.34 bps | R1 |
| 5 | WBNB/BUSD | 100, 500, 10000 | 57.04 bps | R1 |
| 6 | USDT/USDC | 100, 500, 10000 | 32.44 bps | R1 |
| 7 | USDT/BTCB | 500, 10000 | 47.78 bps | R1 |
| 8 | ETH/USDT | 100, 500 | 2.74 bps | R1 |
| 9 | USDT/BUSD | 100, 500 | 1.49 bps | R1 |
| 10 | **ETH/USDC** | 100, 500 | 28.60 bps | **R3** |
| 11 | **USDC/BUSD** | 100, 500 | 12.35 bps | **R3** |

### F.6 Conclusion

After 3 rounds of scanning (51 tokens, 1,645 combinations), we are confident we have found **all viable PCS V3 × Uni V3 pairs on BSC**. Further expansion of the Uni V3 × PCS V3 strategy is bounded by Uniswap V3's limited BSC adoption.

**Path forward for more pairs**: THENA V3 integration (Appendix E) — different DEX with broader token coverage.
