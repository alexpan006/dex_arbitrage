# Pool Exploration Notes

## Current Pool Selection

### Whitelist (active — `POOL_DISCOVERY_MODE=whitelist`)

Source: `src/config/pools.ts` → `INITIAL_PAIRS`

| Pair        | Fee Tiers      | Discovered (both DEXes) |
|-------------|---------------|------------------------|
| WBNB/USDT   | 100, 500, 2500 | 100 ✅, 500 ✅, 2500 ❌ |
| WBNB/USDC   | 500, 2500      | 500 ✅, 2500 ❌          |
| ETH/USDT    | 500, 2500      | 500 ✅, 2500 ❌          |
| ETH/WBNB    | 500, 2500      | 500 ✅, 2500 ❌          |

Result: **5 pairs** monitored across **10 pools** (5 Uniswap V3 + 5 PancakeSwap V3).

### Overnight Run Observations (6 hours, March 22-23 2026)

- **0 profitable opportunities** across 17,348 blocks
- USDC/WBNB:500 — very thin pool (UNI side: ~1,047 USDC / 7.97 WBNB). Liquidity cap works but the pool may not be worth monitoring.
- ETH/WBNB:500 — also thin, liquidity cap binding 100% of the time.
- USDT/WBNB:500 — deep pool (2M+ USDT liquidity), but spreads rarely exceed fee cost.
- USDT/WBNB:100 — worst expected profit per quote (~-122 USDT avg). Fee tier 100 = tighter ticks but less liquidity.

### Potential Issues with Current Selection

1. **Too few pairs** — only 5 pairs limits opportunity surface area
2. **Thin pools** — USDC/WBNB and ETH/WBNB on Uniswap are very thin, unlikely to produce profitable arb
3. **Well-arbed pairs** — WBNB/USDT is the most liquid pair on BSC; other bots already arb it efficiently
4. **Missing high-volume pairs** — BTCB pairs, CAKE pairs not included

## Discovery Mode: Factory Events (built, not active)

Set `POOL_DISCOVERY_MODE=events` in `.env` to enable.

### How it works
1. Scans `PoolCreated` events from both factory contracts over last N blocks
2. Finds token pairs that exist on **both** Uniswap V3 and PancakeSwap V3
3. Filters to pairs with matching fee tiers

### Config
- `POOL_DISCOVERY_EVENTS_LOOKBACK_BLOCKS` — how far back to scan (default: 100,000)
- `POOL_DISCOVERY_EVENTS_CHUNK_SIZE` — getLogs chunk size (default: 5,000)
- `POOL_DISCOVERY_MAX_POOLS` — max pairs to accept (default: 200)

### Caveats
- May discover many low-liquidity pairs — but our liquidity cap now handles this
- Scanning large block ranges is slow on free RPC tiers
- Only finds pairs present on **both** DEXes (by design — we need both for arbitrage)

## External Resources for Pool Research

### Analytics Dashboards (manual research)
- **GeckoTerminal** — best for real-time pool data:
  - PancakeSwap V3: `https://www.geckoterminal.com/bsc/pancakeswap-v3-bsc/pools`
  - Uniswap V3: `https://www.geckoterminal.com/bsc/uniswap-bsc/pools`
- **PancakeSwap Info**: `https://pancakeswap.finance/info/v3/bsc`
- **Uniswap Explore**: `https://app.uniswap.org/explore/pools/bnb`
- **DeFiLlama**: `https://defillama.com/dexs/chain/bsc`

### Subgraph / GraphQL (programmatic)
- PancakeSwap V3 BSC subgraph ID: `A1fvJWQLBeUAggX2WQTMm3FKjXTekNXo77ZySun4YN2m`
- Uniswap V3 BSC subgraph ID: `8f1KyiuNYiNGrjagzEVpf6k6KkPG517prtjdrJihgHw`
- Query endpoint: `https://gateway-arbitrum.network.thegraph.com/api/[API_KEY]/subgraphs/id/[ID]`

Example query for top pools by volume:
```graphql
{
  pools(first: 20, orderBy: volumeUSD, orderDirection: desc) {
    id
    token0 { symbol }
    token1 { symbol }
    feeTier
    liquidity
    volumeUSD
    txCount
  }
}
```

### API Endpoints
- DexPaprika: `https://api.dexpaprika.com/networks/bsc/dexes/pancakeswap_v3/pools`

## Factory Addresses

| DEX             | Factory Address                              |
|-----------------|---------------------------------------------|
| Uniswap V3      | `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7` |
| PancakeSwap V3  | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` |

Already configured in `src/config/constants.ts`.

## Candidates to Investigate

Based on GeckoTerminal / DeFiLlama data (March 2026):

| Pair       | PCS V3 Liquidity | UNI V3 Liquidity | Why interesting                          |
|------------|-----------------|-----------------|------------------------------------------|
| BTCB/WBNB  | ~$11.2M          | ~$11.1M          | High volume on both, large TVL            |
| BTCB/USDT  | TBD              | TBD              | Check if exists on both                   |
| CAKE/USDT  | ~$5.5M           | TBD              | PCS native token — may price-lead on PCS  |
| CAKE/WBNB  | TBD              | TBD              | Check if exists on both                   |

### How to add a pair to whitelist

1. Add token to `src/config/tokens.ts` if not present (e.g., BTCB, CAKE)
2. Add entry to `INITIAL_PAIRS` in `src/config/pools.ts`
3. Discovery will call `factory.getPool()` to verify both pools exist
4. If only one DEX has the pool, it's silently skipped

### Alternative: Run events mode to discover everything

```bash
# In .env:
POOL_DISCOVERY_MODE=events
POOL_DISCOVERY_EVENTS_LOOKBACK_BLOCKS=200000
POOL_DISCOVERY_MAX_POOLS=50
```

This will scan both factory contracts for all pool creations and find every overlapping
pair. The liquidity cap will naturally protect against thin pools.
