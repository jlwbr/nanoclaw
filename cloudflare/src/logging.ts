import { CorrelationContext } from './contracts.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  event: string;
  message: string;
  level?: LogLevel;
  correlation?: Partial<CorrelationContext>;
  data?: Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function log(fields: LogFields): void {
  const payload = {
    ts: nowIso(),
    level: fields.level ?? 'info',
    event: fields.event,
    message: fields.message,
    correlation: fields.correlation ?? {},
    data: fields.data ?? {},
  };
  console.log(JSON.stringify(payload));
}

export function logError(
  event: string,
  message: string,
  error: unknown,
  correlation?: Partial<CorrelationContext>,
  data?: Record<string, unknown>,
): void {
  const err =
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : { message: String(error) };
  log({
    event,
    message,
    level: 'error',
    correlation,
    data: {
      ...data,
      error: err,
    },
  });
}
