export type Logger = {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
};

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function formatContext(context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) {
    return "";
  }

  return ` ${JSON.stringify(context)}`;
}

export function createLogger(options: { level?: string } = {}): Logger {
  const configured = (options.level || process.env.SINGULAR_CODE_REVIEW_LOG_LEVEL || "info").toLowerCase();
  const minimum = configured in LEVEL_WEIGHT ? (configured as LogLevel) : "info";

  function write(level: LogLevel, message: string, context?: Record<string, unknown>) {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minimum]) {
      return;
    }

    const line = `[singular-code-review] ${level}: ${message}${formatContext(context)}\n`;
    if (level === "error" || level === "warn") {
      process.stderr.write(line);
    } else {
      process.stderr.write(line);
    }
  }

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
