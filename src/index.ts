import * as dotenv from "dotenv";
dotenv.config();

import { JsonRpcProvider, Wallet, WebSocketProvider } from "ethers";
import { EVENT_DRIVEN, EXECUTION, MONITORING, RPC, STRATEGY, TELEMETRY } from "./config/constants";
import { ExecutionEngine } from "./execution/ExecutionEngine";
import { GasEstimator } from "./execution/GasEstimator";
import { PrivateTxSubmitter } from "./execution/PrivateTxSubmitter";
import { EventListener, PoolRegistryEntry } from "./feeds/EventListener";
import { PoolDiscovery } from "./feeds/PoolDiscovery";
import { PoolDynamicState, PoolState } from "./feeds/PoolStateCache";
import { buildMonitoredPoolsFromGroups, PriceFeed } from "./feeds/PriceFeed";
import { V4PoolRegistry } from "./feeds/V4PoolRegistry";
import { DiscordNotifier } from "./monitoring/DiscordNotifier";
import { RollingDetectorMetrics } from "./monitoring/RollingDetectorMetrics";
import { TelemetryWriter } from "./monitoring/TelemetryWriter";
import { OpportunityDetector } from "./strategy/OpportunityDetector";
import { QuoterService } from "./strategy/QuoterService";
import { createLogger } from "./utils/logger";

const logger = createLogger("index");

function normalizePrivateKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "your_private_key_here") {
    return null;
  }

  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  const isValid = /^0x[0-9a-fA-F]{64}$/.test(withPrefix);
  return isValid ? withPrefix : null;
}

async function main(): Promise<void> {
  logger.info("DEX Arbitrage Bot starting");

  if (!RPC.chainstackWss) {
    throw new Error("CHAINSTACK_WSS_URL not set in .env");
  }
  if (!RPC.chainstackHttp) {
    throw new Error("CHAINSTACK_HTTP_URL not set in .env");
  }

  const wsProvider = new WebSocketProvider(RPC.chainstackWss);
  const fallbackProvider = new JsonRpcProvider(RPC.chainstackHttp);

  const rawPrivateKey = process.env.PRIVATE_KEY || "";
  const privateKey = normalizePrivateKey(rawPrivateKey);
  let engine: ExecutionEngine | null = null;

  if (!EXECUTION.dryRun && !privateKey) {
    throw new Error("Valid PRIVATE_KEY required when DRY_RUN is disabled");
  }

  if (privateKey) {
    const wallet = new Wallet(privateKey, fallbackProvider);
    const gasEstimator = new GasEstimator(fallbackProvider);
    const submitter = new PrivateTxSubmitter(fallbackProvider);
    engine = new ExecutionEngine(wallet, fallbackProvider, gasEstimator, submitter);
    logger.info("execution engine initialized", {
      dryRun: engine.isDryRun(),
      contract: EXECUTION.contractAddress || "(not set)",
    });
  } else {
    logger.info("no PRIVATE_KEY — execution engine disabled (detect-only mode)");
  }

  const V4_REGISTRY_PATH = process.env.V4_REGISTRY_PATH || "data/v4-pool-registry.json";
  const v4Registry = new V4PoolRegistry();
  await v4Registry.load(V4_REGISTRY_PATH);

  const discovery = new PoolDiscovery(fallbackProvider);
  const quoter = new QuoterService(fallbackProvider, v4Registry);
  const notifier = new DiscordNotifier();

  const discoveredGroups = await discovery.discoverAll(v4Registry);
  if (discoveredGroups.length === 0) {
    throw new Error("No cross-DEX pool groups discovered");
  }

  await v4Registry.save(V4_REGISTRY_PATH);

  const monitoredPools = buildMonitoredPoolsFromGroups(discoveredGroups);
  const fallbackPollBlocks = EVENT_DRIVEN.enabled ? EVENT_DRIVEN.fallbackPollBlocks : 1;
  const feed = new PriceFeed(wsProvider, fallbackProvider, monitoredPools, {
    fallbackPollBlocks,
  });

  const telemetry = new TelemetryWriter({
    enabled: TELEMETRY.enabled,
    dataDir: TELEMETRY.dataDir,
    bufferSize: TELEMETRY.bufferSize,
    flushIntervalMs: TELEMETRY.flushIntervalMs,
    maxFileSizeBytes: TELEMETRY.maxFileSizeBytes,
  });
  telemetry.start();

  const detector = new OpportunityDetector(quoter, {
    maxBorrowAmountUsd: STRATEGY.maxBorrowAmountUsd,
    minProfitThresholdUsd: STRATEGY.minProfitThresholdUsd,
  }, telemetry);
  const rolling = new RollingDetectorMetrics(60_000);
  let lastSummaryLogAt = 0;
  let lastDiscordStatusAt = 0;
  let lastDiscordAlertAt = 0;
  let detectionInFlight = false;
  let rerunAfterCurrent = false;
  let lastDetectionAtMs = Date.now();

  async function runDetection(poolStates: PoolState[], blockNumber: number, source: string): Promise<void> {
    lastDetectionAtMs = Date.now();
    const opportunities = await detector.detect(poolStates, blockNumber);
    const metrics = detector.getLastMetrics();
    rolling.add(metrics);
    logger.debug("detector metrics", {
      source,
      blockNumber,
      durationMs: metrics.durationMs,
      pairsScanned: metrics.pairsScanned,
      pairsWithSpread: metrics.pairsWithSpread,
      opportunitiesFound: metrics.opportunitiesFound,
      quoteRoundTripAttempts: metrics.quoteRoundTripAttempts,
      quoteRoundTripFailures: metrics.quoteRoundTripFailures,
      optimizerRuns: metrics.optimizerRuns,
      optimizerEvalCount: metrics.optimizerEvalCount,
      optimizerCacheHits: metrics.optimizerCacheHits,
      optimizerBudgetExhaustedCount: metrics.optimizerBudgetExhaustedCount,
    });

    const nowMs = Date.now();
    if (nowMs - lastSummaryLogAt >= 60_000) {
      lastSummaryLogAt = nowMs;
      const summary = rolling.getSummary(nowMs);
      logger.info("detector rolling summary", {
        windowMs: summary.windowMs,
        sampleCount: summary.sampleCount,
        avgDetectDurationMs: summary.avgDetectDurationMs,
        avgPairsScanned: summary.avgPairsScanned,
        avgPairsWithSpread: summary.avgPairsWithSpread,
        avgOpportunitiesFound: summary.avgOpportunitiesFound,
        avgQuoteRoundTripAttempts: summary.avgQuoteRoundTripAttempts,
        quoteRoundTripFailureRate: summary.quoteRoundTripFailureRate,
        avgOptimizerEvalCount: summary.avgOptimizerEvalCount,
        avgOptimizerCacheHits: summary.avgOptimizerCacheHits,
        optimizerBudgetExhaustedRate: summary.optimizerBudgetExhaustedRate,
      });

      if (notifier.isEnabled() && nowMs - lastDiscordStatusAt >= MONITORING.statusIntervalMs) {
        lastDiscordStatusAt = nowMs;
        await notifier.sendStatus(summary);
      }

      if (notifier.isEnabled() && nowMs - lastDiscordAlertAt >= MONITORING.alertCooldownMs) {
        const warningLines: string[] = [];

        if (summary.quoteRoundTripFailureRate >= MONITORING.quoteFailureRateWarn) {
          warningLines.push(
            `Quote failure rate high: ${(summary.quoteRoundTripFailureRate * 100).toFixed(2)}% (threshold ${(MONITORING.quoteFailureRateWarn * 100).toFixed(2)}%)`
          );
        }

        if (summary.avgDetectDurationMs >= MONITORING.detectDurationWarnMs) {
          warningLines.push(
            `Detect latency high: ${summary.avgDetectDurationMs.toFixed(2)} ms (threshold ${MONITORING.detectDurationWarnMs} ms)`
          );
        }

        if (summary.optimizerBudgetExhaustedRate >= MONITORING.budgetExhaustedRateWarn) {
          warningLines.push(
            `Optimizer budget exhaustion high: ${(summary.optimizerBudgetExhaustedRate * 100).toFixed(2)}% (threshold ${(MONITORING.budgetExhaustedRateWarn * 100).toFixed(2)}%)`
          );
        }

        if (warningLines.length > 0) {
          lastDiscordAlertAt = nowMs;
          await notifier.sendWarning(warningLines);
        }
      }
    }

    if (opportunities.length > 0) {
      const top = opportunities[0];
      logger.info("top opportunity", {
        blockNumber,
        token0: top.token0,
        token1: top.token1,
        fee: top.fee,
        spreadBps: top.grossSpreadBps,
        borrowDex: top.borrowDex,
        amountInToken0: top.estimatedBorrowAmountToken0.toString(),
        amountOutMinToken0: top.amountOutMinToken0.toString(),
      });

      if (engine && !engine.hasPendingTx()) {
        const result = await engine.execute(top);

        if (result) {
          if (notifier.isEnabled()) {
            await notifier.sendTxSubmitted({
              txHash: result.txHash,
              route: result.route,
              token0: top.token0,
              token1: top.token1,
              fee: top.fee,
              borrowAmount: top.estimatedBorrowAmountToken0.toString(),
            });

            if (result.confirmed && result.receipt) {
              await notifier.sendTxConfirmed({
                txHash: result.txHash,
                gasUsed: result.gasUsed?.toString() ?? "unknown",
                blockNumber: result.receipt.blockNumber,
                token0: top.token0,
                token1: top.token1,
              });
            } else if (result.reverted) {
              await notifier.sendTxReverted({
                txHash: result.txHash,
                gasUsed: result.gasUsed?.toString() ?? "unknown",
                token0: top.token0,
                token1: top.token1,
              });
            } else if (result.error) {
              await notifier.sendTxError(result.error);
            }
          }
        }
      }
    }
  }

  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  function triggerDetection(poolStates: PoolState[], blockNumber: number, source: string): void {
    if (detectionInFlight) {
      rerunAfterCurrent = true;
      return;
    }

    void (async () => {
      detectionInFlight = true;
      try {
        let nextBlock = blockNumber;
        do {
          rerunAfterCurrent = false;
          await runDetection(poolStates, nextBlock, source);
          nextBlock = Number(await withTimeout(fallbackProvider.getBlockNumber(), 5_000, "getBlockNumber"));
        } while (rerunAfterCurrent);
      } catch (error) {
        logger.warn("opportunity detection failed", { source, error: String(error) });
      } finally {
        detectionInFlight = false;
      }
    })();
  }

  feed.onUpdate((updated, blockNumber) => {
    logger.debug("price feed updated (fallback poll)", { blockNumber, updatedPools: updated.length });
    triggerDetection(feed.getCache().getAll(), blockNumber, "fallback-poll");
  });

  let eventListener: EventListener | null = null;

  if (EVENT_DRIVEN.enabled) {
    const pendingDetections = new Map<string, ReturnType<typeof setTimeout>>();

    function pairKeyFromPool(pool: PoolRegistryEntry): string {
      const a = pool.token0.toLowerCase();
      const b = pool.token1.toLowerCase();
      const left = a < b ? a : b;
      const right = a < b ? b : a;
      return `${left}:${right}`;
    }

    function scheduleDetection(pairKey: string, blockNumber: number): void {
      const existing = pendingDetections.get(pairKey);
      if (existing) clearTimeout(existing);

      pendingDetections.set(pairKey, setTimeout(() => {
        pendingDetections.delete(pairKey);
        const pairPools = feed.getCache().getAll().filter((s) => {
          const a = s.token0.toLowerCase();
          const b = s.token1.toLowerCase();
          const left = a < b ? a : b;
          const right = a < b ? b : a;
          const key = `${left}:${right}`;
          return key === pairKey;
        });

        if (pairPools.length >= 2) {
          triggerDetection(pairPools, blockNumber, "event-driven");
        }
      }, EVENT_DRIVEN.debounceMs));
    }

    const registryPools: PoolRegistryEntry[] = monitoredPools.map((p) => ({
      poolAddress: p.poolAddress,
      dex: p.dex,
      token0: p.token0,
      token1: p.token1,
      fee: p.fee,
    }));

    eventListener = new EventListener(
      wsProvider,
      fallbackProvider,
      registryPools,
      {
        onSwap: (event) => {
          const pool = registryPools.find(
            (p) => p.poolAddress.toLowerCase() === event.poolAddress.toLowerCase()
          );
          if (!pool) return;

          const dynamic: PoolDynamicState = {
            sqrtPriceX96: event.sqrtPriceX96,
            tick: event.tick,
            liquidity: event.liquidity,
            blockNumber: event.blockNumber,
            updatedAtMs: Date.now(),
          };

          feed.updateSinglePool(event.poolAddress, dynamic);
          const pk = pairKeyFromPool(pool);
          logger.debug("swap event received", { pool: event.poolAddress, dex: event.dex, block: event.blockNumber, pairKey: pk });
          scheduleDetection(pk, event.blockNumber);
        },

        onLiquidityChange: (event) => {
          const pool = registryPools.find(
            (p) => p.poolAddress.toLowerCase() === event.poolAddress.toLowerCase()
          );
          if (!pool) return;

          const pk = pairKeyFromPool(pool);
          logger.debug("liquidity change event", { type: event.type, pool: event.poolAddress, dex: event.dex, block: event.blockNumber });

          void (async () => {
            try {
              const state = await eventListener!.fetchPoolState(event.poolAddress);
              if (!state) return;

              const dynamic: PoolDynamicState = {
                sqrtPriceX96: state.sqrtPriceX96,
                tick: state.tick,
                liquidity: state.liquidity,
                blockNumber: event.blockNumber,
                updatedAtMs: Date.now(),
              };

              feed.updateSinglePool(event.poolAddress, dynamic);
              scheduleDetection(pk, event.blockNumber);
            } catch (err) {
              logger.warn("failed to fetch pool state after liquidity change", { pool: event.poolAddress, error: String(err) });
            }
          })();
        },
      },
      {
        dedupCacheSize: EVENT_DRIVEN.dedupCacheSize,
      }
    );

    await eventListener.start();
    logger.info("event-driven monitoring enabled", {
      fallbackPollBlocks: EVENT_DRIVEN.fallbackPollBlocks,
      debounceMs: EVENT_DRIVEN.debounceMs,
    });
  } else {
    logger.info("event-driven monitoring disabled, using block-polling only");
  }

  await feed.start();

  // Safety-net HTTP poll: fires independently of WSS health to keep the bot alive
  const SAFETY_POLL_INTERVAL_MS = 15_000;

  const safetyPollTimer = setInterval(() => {
    const sinceLast = Date.now() - lastDetectionAtMs;
    if (sinceLast < SAFETY_POLL_INTERVAL_MS) {
      return;
    }

    logger.warn("safety-net poll triggered — no detection for " + Math.round(sinceLast / 1000) + "s", {
      secsSinceLastBlock: feed.getSecondsSinceLastBlock().toFixed(1),
      secsSinceLastEvent: eventListener?.getSecondsSinceLastEvent().toFixed(1) ?? "n/a",
    });

    void (async () => {
      try {
        const block = Number(await withTimeout(fallbackProvider.getBlockNumber(), 5_000, "safetyPoll.getBlockNumber"));
        await feed.refresh(block);
        triggerDetection(feed.getCache().getAll(), block, "safety-poll");
      } catch (err) {
        logger.warn("safety-net poll failed", { error: String(err) });
      }
    })();
  }, SAFETY_POLL_INTERVAL_MS);

  if (notifier.isEnabled()) {
    await notifier.sendStartup(discoveredGroups.length, monitoredPools.length);
  }

  logger.info("Bot initialized. Waiting for blocks", {
    discoveredPairGroups: discoveredGroups.length,
    monitoredPools: monitoredPools.length,
    v4RegistrySize: v4Registry.size(),
  });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    clearInterval(safetyPollTimer);
    if (eventListener) {
      await eventListener.stop();
    }
    await feed.stop();
    await telemetry.stop();
    if (notifier.isEnabled()) {
      await notifier.sendShutdown(signal);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("Fatal error", { error: String(error) });
  process.exit(1);
});
