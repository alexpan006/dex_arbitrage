export const CHAIN_ID = 56;
export const BLOCK_TIME_MS = 450;

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const UNISWAP_V3 = {
  factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
  swapRouter02: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
  quoterV2: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
} as const;

export const PANCAKESWAP_V3 = {
  factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  deployer: "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9",
  smartRouter: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
  swapRouter: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
  quoterV2: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
  initCodeHash: "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2",
} as const;

export const INIT_CODE_HASHES = {
  uniswapV3: "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54",
  pancakeSwapV3: "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2",
} as const;

export const STRATEGY = {
  minProfitThresholdUsd: parseFloat(process.env.MIN_PROFIT_THRESHOLD_USD || "0.50"),
  maxBorrowAmountUsd: parseFloat(process.env.MAX_BORROW_AMOUNT_USD || "10000"),
  maxGasPriceGwei: parseFloat(process.env.MAX_GAS_PRICE_GWEI || "10"),
  spreadDiffBps: parseFloat(process.env.SPREAD_DIFF_BPS || "1"),
} as const;

export const BUILDER = {
  proxyUrl: process.env.BUILDER_PROXY_URL || "https://hongkong.builder.blockrazor.io",
  club48Url: process.env.BUILDER_48CLUB_URL || "https://rpc.48.club",
} as const;

export const RPC = {
  chainstackWss: process.env.CHAINSTACK_WSS_URL || "",
  chainstackHttp: process.env.CHAINSTACK_HTTP_URL || "",
  alchemyHttp: process.env.ALCHEMY_HTTP_URL || "",
} as const;

export const DISCOVERY = {
  mode: (process.env.POOL_DISCOVERY_MODE || "whitelist") as "whitelist" | "events",
  eventsLookbackBlocks: parseInt(process.env.POOL_DISCOVERY_EVENTS_LOOKBACK_BLOCKS || "100000", 10),
  eventsChunkSize: parseInt(process.env.POOL_DISCOVERY_EVENTS_CHUNK_SIZE || "5000", 10),
  maxPools: parseInt(process.env.POOL_DISCOVERY_MAX_POOLS || "200", 10),
} as const;

export const EXECUTION = {
  dryRun: process.env.DRY_RUN !== "false",
  contractAddress: process.env.FLASH_SWAP_ARBITRAGE_ADDRESS || "",
  gasLimitBuffer: parseFloat(process.env.GAS_LIMIT_BUFFER || "1.2"),
  gasLimitCap: parseInt(process.env.GAS_LIMIT_CAP || "1000000", 10),
  txConfirmationTimeoutMs: parseInt(process.env.TX_CONFIRMATION_TIMEOUT_MS || "15000", 10),
  receiptPollIntervalMs: parseInt(process.env.RECEIPT_POLL_INTERVAL_MS || "500", 10),
} as const;

export const MONITORING = {
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  statusIntervalMs: parseInt(process.env.DISCORD_STATUS_INTERVAL_MS || "300000", 10),
  alertCooldownMs: parseInt(process.env.DISCORD_ALERT_COOLDOWN_MS || "300000", 10),
  quoteFailureRateWarn: parseFloat(process.env.DETECTOR_QUOTE_FAILURE_RATE_WARN || "0.30"),
  detectDurationWarnMs: parseInt(process.env.DETECTOR_DURATION_WARN_MS || "250", 10),
  budgetExhaustedRateWarn: parseFloat(process.env.DETECTOR_BUDGET_EXHAUSTED_RATE_WARN || "0.20"),
} as const;

export const TELEMETRY = {
  enabled: process.env.TELEMETRY_ENABLED !== "false",
  dataDir: process.env.TELEMETRY_DATA_DIR || "data/telemetry",
  bufferSize: parseInt(process.env.TELEMETRY_BUFFER_SIZE || "100", 10),
  flushIntervalMs: parseInt(process.env.TELEMETRY_FLUSH_INTERVAL_MS || "5000", 10),
  maxFileSizeBytes: parseInt(process.env.TELEMETRY_MAX_FILE_SIZE_MB || "50", 10) * 1024 * 1024,
} as const;

export const EVENT_DRIVEN = {
  enabled: process.env.EVENT_DRIVEN_ENABLED !== "false",
  fallbackPollBlocks: parseInt(process.env.FALLBACK_POLL_BLOCKS || "10", 10),
  debounceMs: parseInt(process.env.EVENT_DEBOUNCE_MS || "50", 10),
  dedupCacheSize: parseInt(process.env.EVENT_DEDUP_CACHE_SIZE || "5000", 10),
} as const;

export const MIN_SQRT_RATIO = BigInt("4295128739");
export const MAX_SQRT_RATIO = BigInt("1461446703485210103287273052203988822378723970342");
