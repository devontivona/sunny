import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { dataDir, sitesDir, stateDir, type SunnyConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { commitData, commitState, pushData, pushState } from './index.js';

const log = logger('state');

/** The state repo's reserved, code-written top-level set. Everything else found in
 *  `state/` is an agent artifact and relocates to `data/` (runtime-home-data-split). */
const RESERVED = new Set(['memory', 'credentials.json', 'schedules', 'mcp.json']);

function isGitPlumbing(name: string): boolean {
  return name === '.git' || name === '.gitignore' || name === '.gitattributes';
}

/**
 * One-time, idempotent boot migration (runtime-home-data-split): relocate agent
 * artifacts into the `data/` repository.
 *
 * 1. Reserved-set rule — every top-level `state/` entry that is not reserved
 *    (`memory/`, `credentials.json`, `schedules/`, `mcp.json`) or git plumbing moves
 *    to `data/`, tracked or untracked alike. A deterministic rule beats an allowlist
 *    of known litter: it also catches strays we haven't found.
 * 2. Legacy sites — `~/.sunny/sites/` (the pre-runtime-home path that stale skill
 *    guidance kept populating) merges into `data/sites/`. On slug collision the copy
 *    with the newest content mtime wins the working tree; the OLDER copy is committed
 *    to the data repo first so it survives in history (the legacy dir was never
 *    git-tracked — dropping its copy outright would be unrecoverable).
 * 3. The removals are committed in the state repo, the arrivals in the data repo,
 *    and both push best-effort.
 *
 * Re-running is a no-op: with no non-reserved entries and no legacy sites dir it
 * returns before touching git. Best-effort throughout — a failure logs and leaves
 * the remaining entries for the next boot.
 */
export async function migrateAgentArtifactsToData(config: SunnyConfig): Promise<void> {
  const state = stateDir(config.runtimeDir);
  const data = dataDir(config.runtimeDir);
  const legacySites = join(config.runtimeDir, 'sites');

  const strays = existsSync(state)
    ? readdirSync(state).filter((name) => !RESERVED.has(name) && !isGitPlumbing(name))
    : [];
  const hasLegacy = existsSync(legacySites);
  if (strays.length === 0 && !hasLegacy) return;

  log.info('migrating agent artifacts into ~/.sunny/data', {
    fromState: strays,
    legacySites: hasLegacy,
  });

  let movedFromState = false;
  for (const name of strays) {
    const src = join(state, name);
    const dest = join(data, name);
    try {
      if (name === 'sites') {
        // Merge per-slug so a partially-populated data/sites never blocks the move.
        mkdirSync(dest, { recursive: true });
        for (const slug of readdirSync(src)) {
          const slugDest = join(dest, slug);
          if (existsSync(slugDest)) {
            log.warn('migration skipped state site (already in data/sites)', { slug });
            continue;
          }
          renameSync(join(src, slug), slugDest);
          movedFromState = true;
        }
        if (readdirSync(src).length === 0) rmdirSync(src);
      } else {
        if (existsSync(dest)) {
          log.warn('migration skipped state entry (destination exists in data/)', { name });
          continue;
        }
        mkdirSync(data, { recursive: true });
        renameSync(src, dest);
        movedFromState = true;
      }
    } catch (err) {
      log.warn('migration could not move state entry (left for next boot)', {
        name,
        err: String(err),
      });
    }
  }

  if (hasLegacy) {
    const sites = sitesDir(config.runtimeDir);
    mkdirSync(sites, { recursive: true });
    for (const slug of readdirSync(legacySites)) {
      const src = join(legacySites, slug);
      const dest = join(sites, slug);
      try {
        if (!existsSync(dest)) {
          renameSync(src, dest);
          continue;
        }
        // Collision: newest content mtime wins the working tree; commit the older
        // copy into data-repo history first so neither version is ever lost.
        if (newestMtimeMs(src) > newestMtimeMs(dest)) {
          // Legacy is newer: the older state copy is already in the tree — commit it,
          // then replace it with the legacy copy.
          await commitData(config, `migrate: preserve older copy of site ${slug}`);
          rmSync(dest, { recursive: true, force: true });
          renameSync(src, dest);
        } else {
          // Legacy is older: park the newer copy, commit the legacy copy so it enters
          // history, then restore the newer copy as the working-tree version.
          const parked = `${dest}.migrate-newer`;
          renameSync(dest, parked);
          renameSync(src, dest);
          await commitData(config, `migrate: preserve older copy of site ${slug}`);
          rmSync(dest, { recursive: true, force: true });
          renameSync(parked, dest);
        }
        log.info('merged colliding site (newest copy kept; older in data-repo history)', { slug });
      } catch (err) {
        log.warn('migration could not merge legacy site (left in place)', {
          slug,
          err: String(err),
        });
      }
    }
    try {
      if (readdirSync(legacySites).length === 0) rmdirSync(legacySites);
    } catch {
      /* leave a non-empty legacy dir for the next boot */
    }
  }

  if (movedFromState) {
    await commitState(config.runtimeDir, 'migrate: relocate agent artifacts to ~/.sunny/data');
  }
  await commitData(config, 'migrate: relocate agent artifacts from state');
  await pushState(config);
  await pushData(config);
}

/** Newest CONTENT mtime under `path`: the file's own, or the max across a directory's
 *  files (recursive). A directory's own mtime is deliberately ignored — it reflects the
 *  move/creation we just performed, not how recent the site's content is; an empty
 *  directory falls back to its own mtime. */
function newestMtimeMs(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const name of readdirSync(path)) {
    try {
      newest = Math.max(newest, newestMtimeMs(join(path, name)));
    } catch {
      /* entry vanished mid-walk — ignore */
    }
  }
  return newest || stat.mtimeMs;
}
