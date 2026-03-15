type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[DEFAULT_LEVEL];
}

function formatLine(level: LogLevel, scope: string, message: string, meta?: unknown): string {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${scope}]`;

  if (meta === undefined) {
    return `${prefix} ${message}`;
  }

  return `${prefix} ${message} ${JSON.stringify(meta)}`;
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug(message: string, meta?: unknown): void {
      if (shouldLog("debug")) {
        console.debug(formatLine("debug", scope, message, meta));
      }
    },
    info(message: string, meta?: unknown): void {
      if (shouldLog("info")) {
        console.info(formatLine("info", scope, message, meta));
      }
    },
    warn(message: string, meta?: unknown): void {
      if (shouldLog("warn")) {
        console.warn(formatLine("warn", scope, message, meta));
      }
    },
    error(message: string, meta?: unknown): void {
      if (shouldLog("error")) {
        console.error(formatLine("error", scope, message, meta));
      }
    },
  };
}
