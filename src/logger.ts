/**
 * Minimal structured logger for Sunny's own components. The Chat SDK has its
 * own `Logger`/`ConsoleLogger`; this is for the gateway seam, agent loop, and
 * server so their output is consistent and greppable. Real OTel/audit logging
 * arrives in Phase 6 (observability).
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[${level}] ${scope}: ${msg}`;
  const args = extra ? [line, extra] : [line];
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
