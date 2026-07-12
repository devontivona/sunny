import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gcScratch } from './index.js';

const DAY_MS = 24 * 60 * 60_000;

function makeScratch(): string {
  return mkdtempSync(join(tmpdir(), 'sunny-scratch-'));
}

/** Set both atime and mtime to `ageMs` before `now`. */
function ageEntry(path: string, now: number, ageMs: number): void {
  const t = new Date(now - ageMs);
  utimesSync(path, t, t);
}

describe('gcScratch (runtime-home-data-split)', () => {
  it('deletes entries older than the threshold and keeps fresh ones', () => {
    const dir = makeScratch();
    const now = Date.now();
    writeFileSync(join(dir, 'old-download.zip'), 'x');
    ageEntry(join(dir, 'old-download.zip'), now, 20 * DAY_MS);
    writeFileSync(join(dir, 'fresh.txt'), 'x');

    const deleted = gcScratch(dir, 14 * DAY_MS, now);

    expect(deleted).toEqual(['old-download.zip']);
    expect(existsSync(join(dir, 'old-download.zip'))).toBe(false);
    expect(existsSync(join(dir, 'fresh.txt'))).toBe(true);
  });

  it('a directory ages by its NEWEST file — one fresh file protects the whole folder', () => {
    const dir = makeScratch();
    const now = Date.now();
    const project = join(dir, 'wip');
    mkdirSync(project);
    writeFileSync(join(project, 'stale.txt'), 'x');
    writeFileSync(join(project, 'active.txt'), 'x');
    ageEntry(join(project, 'stale.txt'), now, 30 * DAY_MS);
    ageEntry(join(project, 'active.txt'), now, 1 * DAY_MS);
    ageEntry(project, now, 30 * DAY_MS);

    expect(gcScratch(dir, 14 * DAY_MS, now)).toEqual([]);
    expect(existsSync(project)).toBe(true);
  });

  it('deletes a directory whose entire contents are old (recursively)', () => {
    const dir = makeScratch();
    const now = Date.now();
    const stale = join(dir, 'abandoned');
    mkdirSync(join(stale, 'nested'), { recursive: true });
    writeFileSync(join(stale, 'nested', 'file.txt'), 'x');
    ageEntry(join(stale, 'nested', 'file.txt'), now, 30 * DAY_MS);
    ageEntry(join(stale, 'nested'), now, 30 * DAY_MS);
    ageEntry(stale, now, 30 * DAY_MS);

    expect(gcScratch(dir, 14 * DAY_MS, now)).toEqual(['abandoned']);
    expect(existsSync(stale)).toBe(false);
  });

  it('respects a different threshold', () => {
    const dir = makeScratch();
    const now = Date.now();
    writeFileSync(join(dir, 'recent.txt'), 'x');
    ageEntry(join(dir, 'recent.txt'), now, 3 * DAY_MS);

    // 14-day threshold keeps it; 2-day threshold collects it.
    expect(gcScratch(dir, 14 * DAY_MS, now)).toEqual([]);
    expect(gcScratch(dir, 2 * DAY_MS, now)).toEqual(['recent.txt']);
  });

  it('is a no-op when the scratch dir does not exist', () => {
    expect(gcScratch(join(tmpdir(), 'sunny-scratch-nonexistent'), DAY_MS, Date.now())).toEqual([]);
  });
});
