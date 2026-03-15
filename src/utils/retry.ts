export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 4,
  initialDelayMs: 100,
  maxDelayMs: 2_000,
  backoffFactor: 2,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(fn: () => Promise<T>, options: Partial<RetryOptions> = {}): Promise<T> {
  const cfg: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
  let delayMs = cfg.initialDelayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === cfg.maxAttempts) {
        break;
      }

      await sleep(delayMs);
      delayMs = Math.min(cfg.maxDelayMs, Math.floor(delayMs * cfg.backoffFactor));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
