import * as dotenv from "dotenv";
dotenv.config();

import { JsonRpcProvider } from "ethers";
import { PoolDiscovery, DiscoveredPairGroup } from "../src/feeds/PoolDiscovery";
import { V4PoolRegistry } from "../src/feeds/V4PoolRegistry";
import { Dex, isV4StyleDex } from "../src/config/pools";

const REGISTRY_PATH = process.env.V4_REGISTRY_PATH || "data/v4-pool-registry.json";

const RPC_URL = process.env.ALCHEMY_HTTP_URL
  || process.env.CHAINSTACK_HTTP_URL
  || "";

async function main() {
  if (!RPC_URL) {
    console.error("No RPC URL set. Set ALCHEMY_HTTP_URL or CHAINSTACK_HTTP_URL in .env");
    process.exit(1);
  }

  console.log("V4/Infinity Pool Scanner");
  console.log("=".repeat(80));
  console.log(`RPC: ${RPC_URL.substring(0, 50)}...`);
  console.log();

  const provider = new JsonRpcProvider(RPC_URL);
  const blockNumber = await provider.getBlockNumber();
  console.log(`Block: ${blockNumber}\n`);

  const registry = new V4PoolRegistry();

  const cached = await registry.load(REGISTRY_PATH);
  console.log(`Loaded ${cached} cached V4 pool entries\n`);

  const discovery = new PoolDiscovery(provider);
  const groups: DiscoveredPairGroup[] = await discovery.discoverAll(registry);

  await registry.save(REGISTRY_PATH);
  console.log(`\nRegistry saved to ${REGISTRY_PATH} (${registry.size()} entries)\n`);

  console.log("=".repeat(80));
  console.log("DISCOVERY RESULTS");
  console.log("=".repeat(80));
  console.log(`Total pair groups: ${groups.length}`);
  console.log();

  const v4Pools = registry.getAllByDex(Dex.UniswapV4);
  const pcsInfPools = registry.getAllByDex(Dex.PancakeSwapInfinity);
  console.log(`Uniswap V4 pools found: ${v4Pools.length}`);
  console.log(`PCS Infinity CLMM pools found: ${pcsInfPools.length}`);
  console.log();

  console.log("CROSS-DEX PAIR GROUPS (2+ DEXes):");
  console.log("-".repeat(100));
  console.log(
    padR("Token Pair", 45),
    padR("Pools", 8),
    padR("DEXes", 50),
  );
  console.log("-".repeat(100));

  for (const group of groups) {
    const token0Short = group.token0.slice(0, 10) + "...";
    const token1Short = group.token1.slice(0, 10) + "...";
    const pair = `${token0Short} / ${token1Short}`;
    const dexes = group.pools.map((p) => `${p.dex}:${p.fee}`).join(", ");
    console.log(
      padR(pair, 45),
      padR(String(group.pools.length), 8),
      padR(dexes, 50),
    );
  }
  console.log();

  const crossV4Groups = groups.filter((g) => {
    const hasV3 = g.pools.some((p) => !isV4StyleDex(p.dex));
    const hasV4 = g.pools.some((p) => isV4StyleDex(p.dex));
    return hasV3 && hasV4;
  });

  console.log(`\nCross-architecture pair groups (V3 ↔ V4/Infinity): ${crossV4Groups.length}`);
  for (const g of crossV4Groups) {
    const t0 = g.token0.slice(0, 10) + "...";
    const t1 = g.token1.slice(0, 10) + "...";
    const dexes = g.pools.map((p) => `${p.dex}:${p.fee}`).join(", ");
    console.log(`  ${t0}/${t1} → [${dexes}]`);
  }

  console.log("\nDone.");
}

function padR(s: string, n: number): string {
  return s.padEnd(n);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
