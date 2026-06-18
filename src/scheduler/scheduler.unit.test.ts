import { describe, expect, it } from 'vitest';
import { computeNextRun, parseDuration } from './index.js';

describe('parseDuration', () => {
  it('parses each unit into milliseconds', () => {
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('tolerates surrounding whitespace and a space before the unit', () => {
    expect(parseDuration('  30 m ')).toBe(1_800_000);
  });

  it('throws on an invalid spec', () => {
    expect(() => parseDuration('soon')).toThrow(/invalid interval/);
    expect(() => parseDuration('10w')).toThrow(/invalid interval/);
    expect(() => parseDuration('')).toThrow(/invalid interval/);
  });
});

describe('computeNextRun', () => {
  const from = new Date('2026-01-01T12:00:00.000Z');

  it('once: returns the parsed timestamp', () => {
    const at = computeNextRun('once', '2026-02-01T09:00:00.000Z', from, 'America/New_York');
    expect(at?.toISOString()).toBe('2026-02-01T09:00:00.000Z');
  });

  it('once: throws on an invalid timestamp', () => {
    expect(() => computeNextRun('once', 'not-a-date', from, 'UTC')).toThrow(/invalid timestamp/);
  });

  it('interval: adds the duration to `from`', () => {
    const at = computeNextRun('interval', '2h', from, 'UTC');
    expect(at?.toISOString()).toBe('2026-01-01T14:00:00.000Z');
  });

  it('cron: computes the next occurrence in the given timezone', () => {
    // 09:00 America/New_York on 2026-01-01 is 14:00 UTC (EST, UTC-5).
    const at = computeNextRun('cron', '0 9 * * *', from, 'America/New_York');
    expect(at?.toISOString()).toBe('2026-01-01T14:00:00.000Z');
  });

  it('cron: the same expression differs by timezone', () => {
    // from is 12:00 UTC (= 07:00 EST). In NY, 09:00 is still ahead → today 14:00 UTC.
    // In UTC, 09:00 has already passed → tomorrow 09:00 UTC.
    const ny = computeNextRun('cron', '0 9 * * *', from, 'America/New_York');
    const utc = computeNextRun('cron', '0 9 * * *', from, 'UTC');
    expect(ny?.toISOString()).not.toBe(utc?.toISOString());
    expect(utc?.toISOString()).toBe('2026-01-02T09:00:00.000Z');
  });

  it('cron: throws on an invalid expression', () => {
    expect(() => computeNextRun('cron', 'not a cron', from, 'UTC')).toThrow();
  });
});
