import * as fs from "fs";
import * as path from "path";
import { createLogger } from "../utils/logger";

const logger = createLogger("TelemetryWriter");

export interface TelemetryRecord {
  timestamp: string;
  blockNumber: number;
  pair: string;
  dexA: string;
  dexB: string;
  priceA: number;
  priceB: number;
  spreadBps: number;
  spreadAboveThreshold: boolean;
  quoteAttempted: boolean;
  borrowAmount?: string;
  firstLegOut?: string;
  secondLegOut?: string;
  expectedProfit?: string;
  profitAboveMin?: boolean;
  maxBorrowToken0?: string;
  liquidityCap?: string;
  rejectReason:
    | "spread_below_min"
    | "no_cross_dex_pair"
    | "quote_failed"
    | "optimizer_no_candidate"
    | "profit_below_min"
    | "accepted";
}

export interface BlockSummaryRecord {
  timestamp: string;
  blockNumber: number;
  pairsScanned: number;
  pairsWithSpread: number;
  opportunitiesFound: number;
  quoteRoundTripAttempts: number;
  quoteRoundTripFailures: number;
  detectDurationMs: number;
}

export interface TelemetryWriterOptions {
  /** Directory for telemetry JSONL files. Default: `data/telemetry` */
  dataDir: string;
  /** Max records to buffer before flushing. Default: 100 */
  bufferSize: number;
  /** Max flush interval in ms. Default: 5000 (5s) */
  flushIntervalMs: number;
  /** Max file size in bytes before rotation. Default: 50MB */
  maxFileSizeBytes: number;
  /** Whether telemetry is enabled. Default: true */
  enabled: boolean;
}

const DEFAULT_OPTIONS: TelemetryWriterOptions = {
  dataDir: "data/telemetry",
  bufferSize: 100,
  flushIntervalMs: 5_000,
  maxFileSizeBytes: 50 * 1024 * 1024,
  enabled: true,
};

export class TelemetryWriter {
  private readonly options: TelemetryWriterOptions;
  private readonly pairBuffer: string[] = [];
  private readonly blockBuffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private currentPairFile: string = "";
  private currentBlockFile: string = "";
  private currentPairFileSize = 0;
  private currentBlockFileSize = 0;
  private flushing = false;

  constructor(options: Partial<TelemetryWriterOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (!this.options.enabled) {
      logger.info("telemetry disabled");
      return;
    }

    try {
      fs.mkdirSync(this.options.dataDir, { recursive: true });
    } catch (err) {
      logger.warn("failed to create telemetry directory", { error: String(err) });
      return;
    }

    this.currentPairFile = this.newFileName("pairs");
    this.currentBlockFile = this.newFileName("blocks");
    this.currentPairFileSize = 0;
    this.currentBlockFileSize = 0;

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs);

    if (this.flushTimer && typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }

    logger.info("telemetry writer started", {
      dataDir: this.options.dataDir,
      bufferSize: this.options.bufferSize,
      flushIntervalMs: this.options.flushIntervalMs,
      maxFileSizeBytes: this.options.maxFileSizeBytes,
    });
  }

  recordPair(record: TelemetryRecord): void {
    if (!this.options.enabled) return;
    this.pairBuffer.push(JSON.stringify(record));
    if (this.pairBuffer.length >= this.options.bufferSize) {
      void this.flush();
    }
  }

  recordBlock(record: BlockSummaryRecord): void {
    if (!this.options.enabled) return;
    this.blockBuffer.push(JSON.stringify(record));
    if (this.blockBuffer.length >= this.options.bufferSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.options.enabled) return;
    if (this.flushing) return;
    this.flushing = true;

    try {
      await this.flushBuffer(this.pairBuffer, "pairs");
      await this.flushBuffer(this.blockBuffer, "blocks");
    } catch (err) {
      logger.warn("telemetry flush failed", { error: String(err) });
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    logger.info("telemetry writer stopped");
  }

  getDataDir(): string {
    return this.options.dataDir;
  }

  isEnabled(): boolean {
    return this.options.enabled;
  }


  private async flushBuffer(buffer: string[], channel: "pairs" | "blocks"): Promise<void> {
    if (buffer.length === 0) return;

    const lines = buffer.splice(0, buffer.length);
    const data = lines.join("\n") + "\n";
    const dataBytes = Buffer.byteLength(data, "utf8");

    const currentSize = channel === "pairs" ? this.currentPairFileSize : this.currentBlockFileSize;

    if (currentSize + dataBytes > this.options.maxFileSizeBytes) {
      const newFile = this.newFileName(channel);
      if (channel === "pairs") {
        this.currentPairFile = newFile;
        this.currentPairFileSize = 0;
      } else {
        this.currentBlockFile = newFile;
        this.currentBlockFileSize = 0;
      }
      logger.info("telemetry file rotated", { channel, newFile });
    }

    const targetFile = channel === "pairs" ? this.currentPairFile : this.currentBlockFile;

    try {
      await fs.promises.appendFile(targetFile, data, "utf8");
      if (channel === "pairs") {
        this.currentPairFileSize += dataBytes;
      } else {
        this.currentBlockFileSize += dataBytes;
      }
    } catch (err) {
      logger.warn("telemetry write failed", { channel, file: targetFile, error: String(err) });
    }
  }

  private newFileName(channel: string): string {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
    return path.join(this.options.dataDir, `${channel}_${dateStr}.jsonl`);
  }
}
