import type { CorrelationContext } from "./correlation.js";
import { type JsonValue, sanitizeLogDetails } from "./log-sanitizer.js";

export type StageLogLevel = "debug" | "info" | "warn" | "error";

/** Console-shaped sink; injectable so logging is unit-testable. */
export type StageLogSink = Pick<Console, "debug" | "error" | "log" | "warn">;

export type StageLogInput = {
  readonly level: StageLogLevel;
  /** Dotted event tag, e.g. "forward.inbound" (== the telegram-bot `[Tag]` prefix). */
  readonly stage: string;
  readonly message: string;
  /** Request/HTTP correlation. Absent for the self-driven DO loop. */
  readonly correlation?: CorrelationContext;
  /** Base identifiers merged top-level into the record (svc, botId, chatId, ...). */
  readonly context?: Record<string, unknown>;
  /** Extra per-event fields; always sanitized before emit. */
  readonly details?: Record<string, unknown>;
};

export type StageLogRecord = Record<string, JsonValue>;

/**
 * Build the structured log record: fixed `level`/`stage`/`message`, optional
 * correlation (`request_id`/`cf_ray`), sanitized `context` merged top-level (so
 * ids stay queryable), and sanitized `details` nested under `details`.
 */
export function createStageLogRecord(input: StageLogInput): StageLogRecord {
  const record: Record<string, JsonValue> = {
    level: input.level,
    stage: input.stage,
    message: input.message,
  };

  if (input.correlation) {
    record.request_id = input.correlation.request_id;
    if (input.correlation.cf_ray !== undefined) {
      record.cf_ray = input.correlation.cf_ray;
    }
  }

  if (input.context) {
    for (const [key, value] of Object.entries(sanitizeLogDetails(input.context))) {
      record[key] = value;
    }
  }

  if (input.details) {
    record.details = sanitizeLogDetails(input.details);
  }

  return record;
}

/** Emit one JSON line to the sink, routed by level. */
export function logStageBoundary(sink: StageLogSink, input: StageLogInput): void {
  const record = JSON.stringify(createStageLogRecord(input));

  switch (input.level) {
    case "error":
      sink.error(record);
      return;
    case "warn":
      sink.warn(record);
      return;
    case "debug":
      sink.debug(record);
      return;
    default:
      sink.log(record);
  }
}

export type StageLogger = {
  readonly debug: (stage: string, message: string, details?: Record<string, unknown>) => void;
  readonly info: (stage: string, message: string, details?: Record<string, unknown>) => void;
  readonly warn: (stage: string, message: string, details?: Record<string, unknown>) => void;
  readonly error: (stage: string, message: string, details?: Record<string, unknown>) => void;
  /** Derive a logger with extra base context (e.g. per-chat botId/chatId). */
  readonly child: (extraContext: Record<string, unknown>) => StageLogger;
};

/**
 * Bind a sink + base context (+ optional correlation) into a small leveled
 * logger so call sites read `log.info("forward.inbound", "routed", { gatewayId })`.
 * Defaults to the global `console` (Workers Logs on an isolate; stdout in Node).
 */
export function createStageLogger(options: {
  readonly context?: Record<string, unknown>;
  readonly correlation?: CorrelationContext;
  readonly sink?: StageLogSink;
}): StageLogger {
  const sink = options.sink ?? console;
  const baseContext = options.context;
  const correlation = options.correlation;

  const emit =
    (level: StageLogLevel) =>
    (stage: string, message: string, details?: Record<string, unknown>): void => {
      logStageBoundary(sink, {
        level,
        stage,
        message,
        correlation,
        context: baseContext,
        details,
      });
    };

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (extraContext) =>
      createStageLogger({
        context: { ...(baseContext ?? {}), ...extraContext },
        correlation,
        sink,
      }),
  };
}
