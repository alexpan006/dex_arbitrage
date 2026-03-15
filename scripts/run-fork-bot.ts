import * as dotenv from "dotenv";
dotenv.config();

import { spawn, ChildProcess } from "child_process";
import { JsonRpcProvider, Wallet, WebSocketProvider, parseEther, ContractFactory } from "ethers";
import { readFileSync } from "fs";
import { join } from "path";
import { PoolDiscovery } from "../src/feeds/PoolDiscovery";
import { buildMonitoredPools, PriceFeed } from "../src/feeds/PriceFeed";
import { OpportunityDetector } from "../src/strategy/OpportunityDetector";
import { QuoterService } from "../src/strategy/QuoterService";
import { ExecutionEngine } from "../src/execution/ExecutionEngine";
import { GasEstimator } from "../src/execution/GasEstimator";
import { PrivateTxSubmitter } from "../src/execution/PrivateTxSubmitter";
import { createLogger } from "../src/utils/logger";
import { createDivergence } from "./create-fork-divergence";

const logger = createLogger("fork-bot");

const ANVIL_PORT = parseInt(process.env.ANVIL_PORT || "8545", 10);
const ANVIL_HTTP = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_WS = `ws://127.0.0.1:${ANVIL_PORT}`;
const BSC_RPC = process.env.CHAINSTACK_HTTP_URL || "https://bsc-dataseed1.binance.org";

const ANVIL_DEFAULT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const CONSTRUCTOR_ARGS = {
  uniswapV3Factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
  pancakeV3Deployer: "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9",
  uniswapV3InitCodeHash: "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54",
  pancakeV3InitCodeHash: "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2",
};

const MAX_DETECTION_CYCLES = parseInt(process.env.FORK_MAX_CYCLES || "20", 10);

function startAnvil(): Promise<{ process: ChildProcess; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const args = [
      "--fork-url", BSC_RPC,
      "--port", String(ANVIL_PORT),
      "--chain-id", "56",
      "--gas-price", "3000000000",
      "--block-time", "1",
      "--accounts", "10",
      "--balance", "10000",
    ];

    logger.info("spawning anvil", { args: args.join(" ") });
    const child = spawn("anvil", args, { stdio: ["ignore", "pipe", "pipe"] });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        child.kill("SIGINT");
        reject(new Error("Anvil failed to start within 30s"));
      }
    }, 30_000);

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      if (!started && text.includes("Listening on")) {
        started = true;
        clearTimeout(timeout);
        logger.info("anvil ready", { port: ANVIL_PORT });
        resolve({
          process: child,
          stop: () => child.kill("SIGINT"),
        });
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        logger.warn("anvil stderr", { msg });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Anvil spawn error: ${err.message}`));
    });

    child.on("exit", (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Anvil exited with code ${code} before starting`));
      }
    });
  });
}

async function fundWallet(provider: JsonRpcProvider, address: string): Promise<void> {
  await provider.send("anvil_setBalance", [address, parseEther("100").toString()]);
  const balance = await provider.getBalance(address);
  logger.info("wallet funded", { address, balanceBnb: Number(balance) / 1e18 });
}

async function deployContract(_provider: JsonRpcProvider, wallet: Wallet): Promise<string> {
  const artifactPath = join(__dirname, "..", "artifacts", "contracts", "FlashSwapArbitrage.sol", "FlashSwapArbitrage.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));

  const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(
    CONSTRUCTOR_ARGS.uniswapV3Factory,
    CONSTRUCTOR_ARGS.pancakeV3Deployer,
    CONSTRUCTOR_ARGS.uniswapV3InitCodeHash,
    CONSTRUCTOR_ARGS.pancakeV3InitCodeHash,
    { gasPrice: 3_000_000_000n }
  );
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  logger.info("contract deployed", { address });
  return address;
}

async function runDetectionLoop(
  wsProvider: WebSocketProvider,
  httpProvider: JsonRpcProvider,
  engine: ExecutionEngine,
  maxCycles: number,
  enableDivergence: boolean
): Promise<void> {
  const discovery = new PoolDiscovery(httpProvider);
  const quoter = new QuoterService(httpProvider);

  logger.info("discovering pools...");
  const discoveredPairs = await discovery.discover();
  if (discoveredPairs.length === 0) {
    logger.warn("no shared pools found — nothing to arbitrage");
    return;
  }
  logger.info("pools discovered", { count: discoveredPairs.length });

  if (enableDivergence && discoveredPairs.length > 0) {
    // Prefer fee >= 500 pools — fee-100 (tick spacing 1) causes Anvil to hang
    // due to massive tick bitmap RPC fetches on fork. Fee-500 (tick spacing 10)
    // and fee-2500 (tick spacing 50) are much faster.
    const targetPair =
      discoveredPairs.find((p) => p.fee >= 500) ?? discoveredPairs[0];
    if (targetPair.fee < 500) {
      logger.warn("no fee >= 500 pool found — using fee-100 pool (may be slow on fork)", {
        fee: targetPair.fee,
      });
    }
    const priceDeltaBps = parseInt(process.env.FORK_DIVERGENCE_BPS || "30", 10);
    logger.info("creating artificial price divergence via slot0 manipulation", {
      pool: targetPair.pancakePool,
      fee: targetPair.fee,
      priceDeltaBps,
    });
    try {
      const divergenceResult = await createDivergence(
        httpProvider,
        targetPair.pancakePool,
        targetPair.token0,
        targetPair.token1,
        targetPair.fee,
        0n,
        priceDeltaBps
      );
      logger.info("divergence created", {
        pool: divergenceResult.poolAddress,
        priceMovePercent: divergenceResult.priceMovePercent.toFixed(4),
      });
    } catch (err) {
      logger.error("divergence creation failed — continuing without it", { error: String(err) });
    }
  }

  const monitoredPools = buildMonitoredPools(discoveredPairs);
  const feed = new PriceFeed(wsProvider, httpProvider, monitoredPools);
  const detector = new OpportunityDetector(quoter, {
    maxBorrowToken0: 100n * 10n ** 18n,
    minSpreadBps: 1,
    minExpectedProfitToken0: 1n,
    minBorrowToken0: 1n * 10n ** 16n,
    coarseRatiosBps: [100, 300, 500, 1000, 2000, 3500, 5000],
    refineIterations: 4,
    maxQuoteEvaluations: 16,
  });

  let cyclesRun = 0;
  let opportunitiesFound = 0;
  let executionsAttempted = 0;

  await new Promise<void>((resolve) => {
    feed.onUpdate((_updated, blockNumber) => {
      if (cyclesRun >= maxCycles) {
        return;
      }

      void (async () => {
        cyclesRun++;
        logger.info(`detection cycle ${cyclesRun}/${maxCycles}`, { blockNumber });

        try {
          const opportunities = await detector.detect(feed.getCache().getAll());
          const metrics = detector.getLastMetrics();

          logger.info("detection result", {
            cycle: cyclesRun,
            pairsScanned: metrics.pairsScanned,
            pairsWithSpread: metrics.pairsWithSpread,
            opportunitiesFound: metrics.opportunitiesFound,
            quoteRoundTripAttempts: metrics.quoteRoundTripAttempts,
            quoteRoundTripFailures: metrics.quoteRoundTripFailures,
            optimizerEvalCount: metrics.optimizerEvalCount,
            durationMs: metrics.durationMs,
          });

          if (opportunities.length > 0) {
            const top = opportunities[0];
            opportunitiesFound++;

            logger.info("opportunity detected", {
              token0: top.token0,
              token1: top.token1,
              fee: top.fee,
              spreadBps: top.grossSpreadBps,
              borrowDex: top.borrowDex,
              amountIn: top.estimatedBorrowAmountToken0.toString(),
              amountOutMin: top.amountOutMinToken0.toString(),
            });

            if (!engine.hasPendingTx()) {
              executionsAttempted++;
              const result = await engine.execute(top);
              if (result) {
                logger.info("execution result", {
                  txHash: result.txHash,
                  route: result.route,
                  confirmed: result.confirmed,
                  reverted: result.reverted,
                  gasUsed: result.gasUsed?.toString() ?? "N/A",
                  error: result.error,
                });
              } else {
                logger.info("execution skipped (dry-run or no contract)");
              }
            }
          }
        } catch (err) {
          logger.warn("detection cycle error", { error: String(err) });
        }

        if (cyclesRun >= maxCycles) {
          logger.info("max cycles reached — stopping");
          await feed.stop();
          resolve();
        }
      })();
    });

    feed.start().catch((err) => {
      logger.error("feed start failed", { error: String(err) });
      resolve();
    });
  });

  logger.info("fork bot summary", {
    totalCycles: cyclesRun,
    opportunitiesFound,
    executionsAttempted,
    isDryRun: engine.isDryRun(),
  });
}

async function main(): Promise<void> {
  logger.info("=== Fork Bot E2E Runner ===");
  logger.info("starting Anvil BSC fork...");

  const anvil = await startAnvil();
  let exitCode = 0;

  try {
    const httpProvider = new JsonRpcProvider(ANVIL_HTTP);
    const wsProvider = new WebSocketProvider(ANVIL_WS);

    const chainId = (await httpProvider.getNetwork()).chainId;
    const blockNumber = await httpProvider.getBlockNumber();
    logger.info("connected to fork", { chainId: Number(chainId), blockNumber });

    const envKey = (process.env.PRIVATE_KEY || "").trim();
    const isValidHexKey = /^(0x)?[0-9a-fA-F]{64}$/.test(envKey);
    const privateKey = isValidHexKey ? envKey : ANVIL_DEFAULT_KEY;
    if (!isValidHexKey) {
      logger.info("no valid PRIVATE_KEY in .env — using Anvil default account");
    }
    const wallet = new Wallet(privateKey, httpProvider);

    await fundWallet(httpProvider, wallet.address);

    logger.info("compiling & deploying contract...");
    const contractAddress = await deployContract(httpProvider, wallet);

    const dryRun = process.env.FORK_DRY_RUN !== "false";
    const gasEstimator = new GasEstimator(httpProvider);
    const submitter = new PrivateTxSubmitter(httpProvider, {
      builderProxyUrl: "http://0.0.0.0:1",
      club48Url: "http://0.0.0.0:1",
      requestTimeoutMs: 500,
    });
    const engine = new ExecutionEngine(wallet, httpProvider, gasEstimator, submitter, {
      dryRun,
      contractAddress,
      txConfirmationTimeoutMs: 10_000,
      receiptPollIntervalMs: 200,
    });

    const enableDivergence = process.env.FORK_CREATE_DIVERGENCE === "true";

    logger.info("execution engine ready", {
      dryRun,
      contractAddress,
      wallet: wallet.address,
      enableDivergence,
    });

    await runDetectionLoop(wsProvider, httpProvider, engine, MAX_DETECTION_CYCLES, enableDivergence);

    logger.info("destroying WebSocket...");
    try {
      wsProvider.destroy().catch(() => {});
    } catch {
      // ethers v6 may synchronously throw during unsubscribe
    }
  } catch (err) {
    logger.error("fork bot failed", { error: String(err) });
    exitCode = 1;
  } finally {
    logger.info("stopping Anvil...");
    anvil.stop();
    await new Promise((r) => setTimeout(r, 1000));
  }

  process.exit(exitCode);
}

process.on("unhandledRejection", () => {});

main();
