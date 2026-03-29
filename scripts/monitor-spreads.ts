/**
 * monitor-spreads.ts
 *
 * Monitors real-time spreads across all viable Uni V3 / PCS V3 pair combinations
 * on BSC. Collects spread distribution statistics over a configurable duration.
 *
 * Usage:
 *   npx ts-node scripts/monitor-spreads.ts [duration_minutes]
 *
 *   duration_minutes  — how long to monitor (default: 10)
 *
 * Outputs:
 *   - Console: live spread updates + final stats summary
 *   - data/spread-monitor-results.json: full sample data
 */

import { Contract, Interface, JsonRpcProvider, getAddress } from "ethers";
import { writeFileSync, mkdirSync } from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL =
  process.env.ALCHEMY_HTTP_URL ||
  process.env.CHAINSTACK_HTTP_URL ||
  "https://bnb-mainnet.g.alchemy.com/v2/17OCGK9ufWUQnXZ7KunC2";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const POLL_INTERVAL_MS = 1000;


// ─── Pool definitions (from scan results — all 21 viable pools) ─────────────

interface MonitoredPair {
  label: string;
  token0: string;
  token1: string;
  fee: number;
  uniPool: string;
  pcsPool: string;
  feeFloorBps: number;
  minSpreadBps: number;
}

const PAIRS: MonitoredPair[] = [
  // ── USDT/WBNB ──
  {
    label: "USDT/WBNB-100",
    token0: "0x55d398326f99059fF775485246999027B3197955",
    token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    fee: 100,
    uniPool: "0x47a90A2d92A8367A91EfA1906bFc8c1E05bf10c4",
    pcsPool: "0x172fcD41E0913e95784454622d1c3724f546f849",
    feeFloorBps: 2,
    minSpreadBps: 3,
  },
  {
    label: "USDT/WBNB-500",
    token0: "0x55d398326f99059fF775485246999027B3197955",
    token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    fee: 500,
    uniPool: "0x6fe9E9de56356F7eDBfcBB29FAb7cd69471a4869",
    pcsPool: "0x36696169C63e42cd08ce11f5deeBbCeBae652050",
    feeFloorBps: 10,
    minSpreadBps: 11,
  },
  {
    label: "USDT/WBNB-10000",
    token0: "0x55d398326f99059fF775485246999027B3197955",
    token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    fee: 10000,
    uniPool: "0x4d170f8714367C44787AE98259CE8Adb72240067",
    pcsPool: "0x6805E0E5333c5c3acCF2930Be4734E2b98f4Ce06",
    feeFloorBps: 200,
    minSpreadBps: 201,
  },
  // ── USDC/WBNB ──
  {
    label: "USDC/WBNB-100",
    token0: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    fee: 100,
    uniPool: "0x4141325bAc36aFFe9Db165e854982230a14e6d48",
    pcsPool: "0xf2688Fb5B81049DFB7703aDa5e770543770612C4",
    feeFloorBps: 2,
    minSpreadBps: 3,
  },
  {
    label: "USDC/WBNB-500",
    token0: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    fee: 500,
    uniPool: "0x5289A8Dbf7029eE0b0498a84777ed3941D9acfEc",
    pcsPool: "0x81A9b5F18179cE2bf8f001b8a634Db80771F1824",
    feeFloorBps: 10,
    minSpreadBps: 11,
  },
  {
    label: "USDC/WBNB-10000",
    token0: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    fee: 10000,
    uniPool: "0xf3E5BeC78654049990965F666B0612E116B94fB2",
    pcsPool: "0x18C5aFFA481e7EDbF37405AdE553827d6387899f",
    feeFloorBps: 200,
    minSpreadBps: 201,
  },
  // ── BTCB/WBNB ──
  {
    label: "BTCB/WBNB-500",
    token0: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
    token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    fee: 500,
    uniPool: "0x28dF0835942396B7a1b7aE1cd068728E6ddBbAfD",
    pcsPool: "0x6bbc40579ad1BBD243895cA0ACB086BB6300d636",
    feeFloorBps: 10,
    minSpreadBps: 11,
  },
  // ── ETH/WBNB ──
  {
    label: "ETH/WBNB-500",
    token0: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    fee: 500,
    uniPool: "0x0f338Ec12d3f7C3D77A4B9fcC1f95F3FB6AD0EA6",
    pcsPool: "0xD0e226f674bBf064f54aB47F42473fF80DB98CBA",
    feeFloorBps: 10,
    minSpreadBps: 11,
  },
  {
    label: "ETH/WBNB-10000",
    token0: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    fee: 10000,
    uniPool: "0xA6317fF234ED629368AF74751c50a816dF726cE3",
    pcsPool: "0x5DEdfB51216F13692cd6Abf5F9c2748b6a3dB852",
    feeFloorBps: 200,
    minSpreadBps: 201,
  },
  // ── WBNB/BUSD ──
  {
    label: "WBNB/BUSD-100",
    token0: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    token1: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    fee: 100,
    uniPool: "0xdb2177Fee5B0eBDc7b8038Cb70F3964bB6d14143",
    pcsPool: "0x8F45b99BF65CDBF9bC0C0b4846D6a324d2DE5314",
    feeFloorBps: 2,
    minSpreadBps: 3,
  },
  {
    label: "WBNB/BUSD-500",
    token0: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    token1: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    fee: 500,
    uniPool: "0xCB99FE720124129520f7a09Ca3CBEF78D58Ed934",
    pcsPool: "0x85FAac652b707FDf6907EF726751087F9E0b6687",
    feeFloorBps: 10,
    minSpreadBps: 11,
  },
  {
    label: "WBNB/BUSD-10000",
    token0: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    token1: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    fee: 10000,
    uniPool: "0xE49f5ca131354Ed5Ffb9273f17Bd7F3017727db6",
    pcsPool: "0x469efaaadB06b5f4618ed1907ABa380411f9a200",
    feeFloorBps: 200,
    minSpreadBps: 201,
  },
  // ── USDT/USDC ──
  {
    label: "USDT/USDC-100",
    token0: "0x55d398326f99059fF775485246999027B3197955",
    token1: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    fee: 100,
    uniPool: "0x2C3c320D49019D4f9A92352e947c7e5AcFE47D68",
    pcsPool: "0x92b7807bF19b7DDdf89b706143896d05228f3121",
    feeFloorBps: 2,
    minSpreadBps: 3,
  },
  {
    label: "USDT/USDC-500",
    token0: "0x55d398326f99059fF775485246999027B3197955",
    token1: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    fee: 500,
    uniPool: "0xcCDFcd1aaC447D5B29980f64b831c532a6a33726",
    pcsPool: "0x4f31Fa980a675570939B737Ebdde0471a4Be40Eb",
    feeFloorBps: 10,
    minSpreadBps: 11,
  },
  {
    label: "USDT/USDC-10000",
    token0: "0x55d398326f99059fF775485246999027B3197955",
    token1: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    fee: 10000,
    uniPool: "0x6A32b830Acac9ad59F23d77e0dC6C6d5E4622D31",
    pcsPool: "0x418E8Bf549Cb4a544d033Edc8bc26C3357e6EFa7",
    feeFloorBps: 200,
    minSpreadBps: 201,
  },
  // ── USDT/BTCB ──
  {
    label: "USDT/BTCB-500",
    token0: "0x55d398326f99059fF775485246999027B3197955",
    token1: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
    fee: 500,
    uniPool: "0x813c0decbB1097fFF46d0Ed6a39fB5f6a83043f4",
    pcsPool: "0x46Cf1cF8c69595804ba91dFdd8d6b960c9B0a7C4",
    feeFloorBps: 10,
    minSpreadBps: 11,
  },
  {
    label: "USDT/BTCB-10000",
    token0: "0x55d398326f99059fF775485246999027B3197955",
    token1: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
    fee: 10000,
    uniPool: "0x2CF9a89dE7B86273d4C7dB9416C0EF160de136c1",
    pcsPool: "0x6f5F1c8856FFacDdD601830E15F56A7461833E89",
    feeFloorBps: 200,
    minSpreadBps: 201,
  },
  // ── ETH/USDT ──
  {
    label: "ETH/USDT-100",
    token0: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    token1: "0x55d398326f99059fF775485246999027B3197955",
    fee: 100,
    uniPool: "0xb125aa15Ad943D96e813E4A06d0c34716F897e26",
    pcsPool: "0x9F599F3D64a9D99eA21e68127Bb6CE99f893DA61",
    feeFloorBps: 2,
    minSpreadBps: 3,
  },
  {
    label: "ETH/USDT-500",
    token0: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    token1: "0x55d398326f99059fF775485246999027B3197955",
    fee: 500,
    uniPool: "0xF9878A5dD55EdC120Fde01893ea713a4f032229c",
    pcsPool: "0xBe141893E4c6AD9272e8C04BAB7E6a10604501a5",
    feeFloorBps: 10,
    minSpreadBps: 11,
  },
  // ── USDT/BUSD ──
  {
    label: "USDT/BUSD-100",
    token0: "0x55d398326f99059fF775485246999027B3197955",
    token1: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    fee: 100,
    uniPool: "0xC98f01bf2141E1140EF8F8caD99D4b021d10718f",
    pcsPool: "0x4f3126d5DE26413AbDCF6948943FB9D0847d9818",
    feeFloorBps: 2,
    minSpreadBps: 3,
  },
  {
    label: "USDT/BUSD-500",
    token0: "0x55d398326f99059fF775485246999027B3197955",
    token1: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    fee: 500,
    uniPool: "0x84E47c7f2fe86f6B5eFBe14feE46B8bb871B2E05",
    pcsPool: "0x1625F94b9185c028733e3Eb41c8203b6b8A11729",
    feeFloorBps: 10,
    minSpreadBps: 11,
  },
];

// ─── ABIs ────────────────────────────────────────────────────────────────────

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) external payable returns ((bool success, bytes returnData)[] returnData)",
];

const POOL_SLOT0_SIG = "function slot0() external view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)";

const poolIface = new Interface([POOL_SLOT0_SIG]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const Q96 = 2n ** 96n;

function sqrtPriceToFloat(sqrtPriceX96: bigint): number {
  const sqrt = Number(sqrtPriceX96) / Number(Q96);
  return sqrt * sqrt;
}

function spreadBps(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  return (Math.abs(a - b) / ((a + b) / 2)) * 10_000;
}

// ─── Spread Sample ───────────────────────────────────────────────────────────

interface SpreadSample {
  timestamp: number;
  block: number;
  label: string;
  uniPrice: number;
  pcsPrice: number;
  spreadBps: number;
  minSpreadBps: number;
  aboveThreshold: boolean;
}

interface PairStats {
  label: string;
  fee: number;
  samples: number;
  minSpread: number;
  maxSpread: number;
  avgSpread: number;
  medianSpread: number;
  p95Spread: number;
  aboveThresholdCount: number;
  aboveThresholdPct: number;
  threshold: number;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const durationMin = parseInt(process.argv[2] || "10", 10);
  const durationMs = durationMin * 60 * 1000;

  console.log("📊 BSC V3 Spread Monitor");
  console.log("=".repeat(80));
  console.log(`RPC: ${RPC_URL.substring(0, 50)}...`);
  console.log(`Pairs: ${PAIRS.length}`);
  console.log(`Duration: ${durationMin} minutes`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log();

  const provider = new JsonRpcProvider(RPC_URL);
  const multicall = new Contract(MULTICALL3, MULTICALL3_ABI, provider);

  // Build slot0 calldata (one per pool, 2 per pair = uniPool + pcsPool)
  const slot0Calldata = poolIface.encodeFunctionData("slot0");

  const allSamples: SpreadSample[] = [];
  const spreadsByPair = new Map<string, number[]>();
  for (const p of PAIRS) {
    spreadsByPair.set(p.label, []);
  }

  const startTime = Date.now();
  let pollCount = 0;
  let errorCount = 0;

  console.log("Monitoring started. Press Ctrl+C to stop early.\n");
  console.log(
    padR("Time", 12),
    padR("Block", 10),
    padR("Pair", 20),
    padR("Spread", 12),
    padR("Threshold", 12),
    "Status",
  );
  console.log("-".repeat(80));

  // Graceful shutdown
  let running = true;
  process.on("SIGINT", () => {
    console.log("\n\nStopping...");
    running = false;
  });

  while (running && Date.now() - startTime < durationMs) {
    try {
      const block = await provider.getBlockNumber();

      // Build multicall: 2 calls per pair (uni slot0 + pcs slot0)
      const calls = PAIRS.flatMap((p) => [
        { target: getAddress(p.uniPool.toLowerCase()), allowFailure: true, callData: slot0Calldata },
        { target: getAddress(p.pcsPool.toLowerCase()), allowFailure: true, callData: slot0Calldata },
      ]);

      const results = await multicall.aggregate3.staticCall(calls);
      const now = Date.now();
      const timeStr = new Date(now).toISOString().substring(11, 19);

      for (let i = 0; i < PAIRS.length; i++) {
        const pair = PAIRS[i];
        const uniResult = results[i * 2];
        const pcsResult = results[i * 2 + 1];

        if (!uniResult.success || !pcsResult.success) continue;

        try {
          const uniSlot0 = poolIface.decodeFunctionResult("slot0", uniResult.returnData);
          const pcsSlot0 = poolIface.decodeFunctionResult("slot0", pcsResult.returnData);

          const uniPrice = sqrtPriceToFloat(BigInt(uniSlot0[0]));
          const pcsPrice = sqrtPriceToFloat(BigInt(pcsSlot0[0]));
          const spread = spreadBps(uniPrice, pcsPrice);
          const above = spread >= pair.minSpreadBps;

          const sample: SpreadSample = {
            timestamp: now,
            block,
            label: pair.label,
            uniPrice,
            pcsPrice,
            spreadBps: spread,
            minSpreadBps: pair.minSpreadBps,
            aboveThreshold: above,
          };
          allSamples.push(sample);
          spreadsByPair.get(pair.label)!.push(spread);

          // Only print notable ones (above threshold or top 3 spread)
          if (above) {
            console.log(
              padR(timeStr, 12),
              padR(String(block), 10),
              padR(pair.label, 20),
              padR(`${spread.toFixed(2)} bps`, 12),
              padR(`${pair.minSpreadBps} bps`, 12),
              "✅ ABOVE",
            );
          }
        } catch {
          // Decode failure — skip
        }
      }

      pollCount++;
      if (pollCount % 30 === 0) {
        const elapsed = ((now - startTime) / 1000).toFixed(0);
        const aboveTotal = allSamples.filter((s) => s.aboveThreshold).length;
        process.stdout.write(
          `\r  [${elapsed}s] polls: ${pollCount} | samples: ${allSamples.length} | above threshold: ${aboveTotal} | errors: ${errorCount}   `,
        );
      }
    } catch (err: unknown) {
      errorCount++;
      if (errorCount <= 5) {
        console.error(`\nPoll error: ${err instanceof Error ? err.message : err}`);
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  console.log("\n\n");

  // ── Statistics ─────────────────────────────────────────────────────────────

  console.log("=".repeat(80));
  console.log("SPREAD STATISTICS");
  console.log("=".repeat(80));

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`Duration: ${elapsed} minutes`);
  console.log(`Total polls: ${pollCount}`);
  console.log(`Total samples: ${allSamples.length}`);
  console.log(`RPC errors: ${errorCount}`);
  console.log();

  const pairStats: PairStats[] = [];

  console.log(
    padR("Pair", 22),
    padR("Samples", 8),
    padR("Min", 10),
    padR("Max", 10),
    padR("Avg", 10),
    padR("Median", 10),
    padR("P95", 10),
    padR("Threshold", 10),
    padR("Above%", 10),
  );
  console.log("-".repeat(110));

  for (const pair of PAIRS) {
    const spreads = spreadsByPair.get(pair.label)!;
    if (spreads.length === 0) {
      console.log(padR(pair.label, 22), "no data");
      continue;
    }

    const sorted = [...spreads].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const aboveCount = spreads.filter((s) => s >= pair.minSpreadBps).length;
    const abovePct = (aboveCount / spreads.length) * 100;

    const stats: PairStats = {
      label: pair.label,
      fee: pair.fee,
      samples: spreads.length,
      minSpread: min,
      maxSpread: max,
      avgSpread: avg,
      medianSpread: median,
      p95Spread: p95,
      aboveThresholdCount: aboveCount,
      aboveThresholdPct: abovePct,
      threshold: pair.minSpreadBps,
    };
    pairStats.push(stats);

    console.log(
      padR(pair.label, 22),
      padR(String(spreads.length), 8),
      padR(`${min.toFixed(2)}`, 10),
      padR(`${max.toFixed(2)}`, 10),
      padR(`${avg.toFixed(2)}`, 10),
      padR(`${median.toFixed(2)}`, 10),
      padR(`${p95.toFixed(2)}`, 10),
      padR(`${pair.minSpreadBps}`, 10),
      padR(`${abovePct.toFixed(1)}%`, 10),
    );
  }

  console.log();

  // ── Above threshold summary ────────────────────────────────────────────────

  const aboveThresholdSamples = allSamples.filter((s) => s.aboveThreshold);
  console.log(`\nTotal above-threshold events: ${aboveThresholdSamples.length}`);
  if (aboveThresholdSamples.length > 0) {
    console.log("Breakdown by pair:");
    const byPair = new Map<string, number>();
    for (const s of aboveThresholdSamples) {
      byPair.set(s.label, (byPair.get(s.label) || 0) + 1);
    }
    for (const [label, count] of [...byPair.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${label}: ${count} events`);
    }
  }

  // ── Save Results ───────────────────────────────────────────────────────────

  mkdirSync("data", { recursive: true });
  const output = {
    monitorTime: new Date().toISOString(),
    durationMinutes: parseFloat(elapsed),
    pollCount,
    totalSamples: allSamples.length,
    errorCount,
    pairStats,
    aboveThresholdEvents: aboveThresholdSamples.map((s) => ({
      time: new Date(s.timestamp).toISOString(),
      block: s.block,
      pair: s.label,
      spread: s.spreadBps,
      threshold: s.minSpreadBps,
    })),
  };

  writeFileSync("data/spread-monitor-results.json", JSON.stringify(output, null, 2));
  console.log("\nResults saved to data/spread-monitor-results.json");
}

function padR(s: string, n: number): string {
  return s.padEnd(n);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
