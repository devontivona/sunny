import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';

const log = logger('scratch');

/**
 * Garbage-collect `~/.sunny/scratch/` (runtime-home-data-split): delete top-level
 * entries older than the configured threshold, at boot and on a daily tick. Scratch is
 * documented to the agent as disposable; this makes that true instead of aspirational.
 *
 * Age is mtime-based so in-flight work is protected: a file ages by its own mtime, a
 * directory by the NEWEST mtime anywhere inside it (a stale folder with one fresh file
 * is still in use). Best-effort — an unreadable or undeletable entry is skipped, never
 * thrown; returns the names of the entries it deleted (for logging/tests).
 */
export function gcScratch(scratchPath: string, maxAgeMs: number, now: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(scratchPath);
  } catch {
    return []; // scratch missing — nothing to collect
  }
  const deleted: string[] = [];
  for (const name of entries) {
    const full = join(scratchPath, name);
    try {
      if (now - newestMtimeMs(full) > maxAgeMs) {
        rmSync(full, { recursive: true, force: true });
        deleted.push(name);
      }
    } catch (err) {
      log.debug('scratch GC skipped entry (non-fatal)', { name, err: String(err) });
    }
  }
  if (deleted.length > 0) {
    log.info('scratch GC collected old entries', { deleted, maxAgeMs });
  }
  return deleted;
}

/** Newest mtime under `path`: the file's own, or the max across a directory's contents
 *  (recursive; an empty directory ages by its own mtime). */
function newestMtimeMs(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const name of readdirSync(path)) {
    try {
      newest = Math.max(newest, newestMtimeMs(join(path, name)));
    } catch {
      /* entry vanished mid-walk — ignore */
    }
  }
  return newest;
}
