import { vi } from 'vitest';

/**
 * Deterministic time control via Vitest fake timers (design D5 / task 2.6).
 *
 * The scheduler/loop/store call `new Date()` / `Date.now()` / `setInterval`
 * directly; rather than refactor production to thread an injected clock, tests
 * mock the clock globally. `vi.useFakeTimers()` replaces `Date`, `Date.now`, and
 * the timer functions; `vi.setSystemTime()` pins "now". Enough to test cron/
 * interval math, the ~60s ticker, and date-tagged behavior with zero waiting and
 * zero production change.
 *
 * Usage (the established pattern):
 *
 *   beforeEach(() => freezeTime());
 *   afterEach(() => unfreezeTime());
 *   // …advance the ticker without real waiting:
 *   await advanceTimersByTimeAsync(60_000);
 */
export const FIXED_NOW = new Date('2026-01-01T12:00:00.000Z');

/** Enter fake-timer mode with the clock pinned at `at` (default {@link FIXED_NOW}). */
export function freezeTime(at: Date = FIXED_NOW): void {
  vi.useFakeTimers();
  vi.setSystemTime(at);
}

/** Restore real timers — pair with {@link freezeTime} in `afterEach`. */
export function unfreezeTime(): void {
  vi.useRealTimers();
}

/**
 * Advance fake time by `ms`, running any timers (e.g. the scheduler `setInterval`)
 * that come due — and awaiting their async callbacks so DB work settles.
 */
export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}
