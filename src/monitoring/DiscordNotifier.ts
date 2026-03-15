import { MONITORING } from "../config/constants";
import { SubmissionRoute } from "../execution/PrivateTxSubmitter";
import { RollingDetectorSummary } from "./RollingDetectorMetrics";

interface DiscordWebhookPayload {
  content: string;
}

export class DiscordNotifier {
  private readonly webhookUrl: string;

  constructor(webhookUrl = MONITORING.discordWebhookUrl) {
    this.webhookUrl = webhookUrl;
  }

  isEnabled(): boolean {
    return this.webhookUrl.length > 0;
  }

  async sendStartup(discoveredPairs: number, monitoredPools: number): Promise<void> {
    await this.send(
      [
        "🟢 **DEX Arbitrage Bot Started**",
        `- Discovered pairs: **${discoveredPairs}**`,
        `- Monitored pools: **${monitoredPools}**`,
      ].join("\n")
    );
  }

  async sendShutdown(reason: string): Promise<void> {
    await this.send(`🔴 **DEX Arbitrage Bot Stopped** — ${reason}`);
  }

  async sendStatus(summary: RollingDetectorSummary): Promise<void> {
    await this.send(
      [
        "📊 **Detector Status (Rolling Window)**",
        `- Window: **${Math.round(summary.windowMs / 1000)}s**`,
        `- Samples: **${summary.sampleCount}**`,
        `- Avg detect latency: **${summary.avgDetectDurationMs.toFixed(2)} ms**`,
        `- Avg pairs scanned: **${summary.avgPairsScanned.toFixed(2)}**`,
        `- Avg pairs with spread: **${summary.avgPairsWithSpread.toFixed(2)}**`,
        `- Avg opportunities: **${summary.avgOpportunitiesFound.toFixed(2)}**`,
        `- Quote failure rate: **${(summary.quoteRoundTripFailureRate * 100).toFixed(2)}%**`,
        `- Avg optimizer evals: **${summary.avgOptimizerEvalCount.toFixed(2)}**`,
        `- Budget exhausted rate: **${(summary.optimizerBudgetExhaustedRate * 100).toFixed(2)}%**`,
      ].join("\n")
    );
  }

  async sendWarning(lines: string[]): Promise<void> {
    await this.send(["⚠️ **Detector Warning**", ...lines.map((line) => `- ${line}`)].join("\n"));
  }

  async sendTxSubmitted(params: {
    txHash: string;
    route: SubmissionRoute;
    token0: string;
    token1: string;
    fee: number;
    borrowAmount: string;
  }): Promise<void> {
    await this.send(
      [
        "📤 **TX Submitted**",
        `- Pair: **${params.token0}/${params.token1}** (fee ${params.fee})`,
        `- Route: **${params.route}**`,
        `- Borrow: **${params.borrowAmount}**`,
        `- TX: \`${params.txHash}\``,
      ].join("\n")
    );
  }

  async sendTxConfirmed(params: {
    txHash: string;
    gasUsed: string;
    blockNumber: number;
    token0: string;
    token1: string;
  }): Promise<void> {
    await this.send(
      [
        "✅ **TX Confirmed**",
        `- Pair: **${params.token0}/${params.token1}**`,
        `- Gas used: **${params.gasUsed}**`,
        `- Block: **${params.blockNumber}**`,
        `- TX: \`${params.txHash}\``,
      ].join("\n")
    );
  }

  async sendTxReverted(params: {
    txHash: string;
    gasUsed: string;
    token0: string;
    token1: string;
  }): Promise<void> {
    await this.send(
      [
        "❌ **TX Reverted**",
        `- Pair: **${params.token0}/${params.token1}**`,
        `- Gas wasted: **${params.gasUsed}**`,
        `- TX: \`${params.txHash}\``,
      ].join("\n")
    );
  }

  async sendTxError(error: string): Promise<void> {
    const safe = error.length > 500 ? error.slice(0, 500) + "…" : error;
    await this.send(`🚨 **TX Submission Error** — ${safe}`);
  }

  private async send(content: string): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const payload: DiscordWebhookPayload = { content };
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Swallow Discord delivery failures — monitoring should never crash the bot
    }
  }
}
