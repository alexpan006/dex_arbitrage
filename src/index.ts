import * as dotenv from "dotenv";
dotenv.config();

import { JsonRpcProvider, Wallet, WebSocketProvider } from "ethers";
import { EXECUTION, MONITORING, RPC, STRATEGY, TELEMETRY } from "./config/constants";
import { ExecutionEngine } from "./execution/ExecutionEngine";
import { GasEstimator } from "./execution/GasEstimator";
import { PrivateTxSubmitter } from "./execution/PrivateTxSubmitter";
import { PoolDiscovery } from "./feeds/PoolDiscovery";
import { buildMonitoredPools, PriceFeed } from "./feeds/PriceFeed";
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

  const discovery = new PoolDiscovery(fallbackProvider);
  const quoter = new QuoterService(fallbackProvider);
  const notifier = new DiscordNotifier();
  const discoveredPairs = await discovery.discover();
  if (discoveredPairs.length === 0) {
    throw new Error("No shared Uniswap/Pancake V3 pools discovered");
  }

  const monitoredPools = buildMonitoredPools(discoveredPairs);
  const feed = new PriceFeed(wsProvider, fallbackProvider, monitoredPools);

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

  feed.onUpdate((updated, blockNumber) => {
    logger.debug("price feed updated", { blockNumber, updatedPools: updated.length });

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

          const opportunities = await detector.detect(feed.getCache().getAll(), nextBlock);
          const metrics = detector.getLastMetrics();
          rolling.add(metrics);
          logger.debug("detector metrics", {
            blockNumber: nextBlock,
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
            optimizerParabolicAcceptedCount: metrics.optimizerParabolicAcceptedCount,
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
              optimizerParabolicAcceptedRate: summary.optimizerParabolicAcceptedRate,
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
              blockNumber: nextBlock,
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

          nextBlock = Number(await fallbackProvider.getBlockNumber());
        } while (rerunAfterCurrent);
      } catch (error) {
        logger.warn("opportunity detection failed", { error: String(error) });
      } finally {
        detectionInFlight = false;
      }
    })();
  });

  await feed.start();

  if (notifier.isEnabled()) {
    await notifier.sendStartup(discoveredPairs.length, monitoredPools.length);
  }

  logger.info("Bot initialized. Waiting for blocks", {
    discoveredPairs: discoveredPairs.length,
    monitoredPools: monitoredPools.length,
  });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
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
