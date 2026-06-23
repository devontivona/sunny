/**
 * Minimal structured logger for Sunny's own components. The Chat SDK has its
 * own `Logger`/`ConsoleLogger`; this is for the gateway seam, agent loop, and
 * server so their output is consistent and greppable.
 *
 * Logs are a telemetry sink, so they pass through the redaction-at-source gate
 * (observability D-OB5): secret values and the Service Account token are
 * scrubbed from the message and its structured `extra` before anything is
 * written. The same redactor backs the OTel/Langfuse and audit sinks.
 */
import { defaultRedactor } from './observability/redact.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, msg: string, extra?: Record<string, unknown>): void {
  const redactor = defaultRedactor();
  const line = `[${level}] ${scope}: ${redactor.redactString(msg)}`;
  const args = extra ? [line, redactor.redact(extra)] : [line];
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit('error', scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof logger>;
