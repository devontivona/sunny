import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stateDir, type SunnyConfig } from '../config/index.js';
import { logger } from '../logger.js';

const log = logger('state');
const exec = promisify(execFile);

/**
 * The `state` repository (runtime-home): `~/.sunny/state/` is a git repo tracking
 * Sunny's durable, portable state — `memory/` (core + `topics/`), `credentials.json`
 * (`op://` references only, never values), and `sites/`. It is a SIBLING of the skill
 * clones and `media/`, so no repo nests inside another's tracked tree and no
 * `.gitignore`-of-siblings is needed.
 *
 * Persistence model: a single `commitState` helper commits on every state write
 * (memory edit, credential-registry update), so history reflects every change; a
 * best-effort `pushState` batches to the owner-controlled PRIVATE remote on the
 * existing periodic cadence (not per-write). All git steps are best-effort and
 * non-fatal — offline leaves the change committed locally; the next push catches up.
 * Mirrors `commitSkillChange`/`syncSkillRepo` in src/skills/index.ts.
 */

/** Expand a `config.state.repo`/`config.skills.repo` value to a clone URL. Accepts
 *  `owner/repo` shorthand (→ GitHub HTTPS) or a full URL / local path passed through.
 *  (Kept in sync with `repoUrl` in src/skills/index.ts; duplicated to avoid coupling
 *  the state module to the skills module.) */
function cloneUrl(repo: string): string {
  return /^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\.{0,2}\/)/.test(repo)
    ? repo
    : `https://github.com/${repo}.git`;
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

function isEmptyDir(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

/**
 * Ensure `~/.sunny/state/` is a git repository (runtime-home). On a FRESH host with
 * a configured private remote and an empty state dir, clone it (so existing memory /
 * credentials come back). Otherwise `git init` in place, wire the remote when one is
 * configured, and make an initial commit. Divergence is handled best-effort (the
 * periodic push reports rejection); we never auto-merge untrusted history here.
 * Best-effort and non-fatal — a host with no git, no network, or a partial state
 * still boots and persists locally. Replaces the old top-level `~/.sunny` seed.
 */
export async function initStateRepo(config: SunnyConfig): Promise<void> {
  const dir = stateDir(config.runtimeDir);
  if (isGitRepo(dir)) return;
  const repo = config.state.repo;
  try {
    if (repo && isEmptyDir(dir)) {
      // Fresh host: clone the private state remote into place.
      mkdirSync(config.runtimeDir, { recursive: true });
      await exec('git', ['clone', '--quiet', cloneUrl(repo), dir]);
      log.info('cloned state repo', { repo });
      return;
    }
    mkdirSync(dir, { recursive: true });
    await exec('git', ['init', '-q'], { cwd: dir });
    if (repo) {
      try {
        await exec('git', ['remote', 'add', 'origin', cloneUrl(repo)], { cwd: dir });
      } catch (err) {
        log.warn('could not set state remote (non-fatal)', { err: String(err) });
      }
    }
    await exec('git', ['add', '-A'], { cwd: dir });
    try {
      await exec('git', ['commit', '-q', '-m', 'seed state repo'], { cwd: dir });
    } catch {
      /* nothing to commit yet (seeds land right after) — fine */
    }
    log.info('initialized state repo', { remote: repo ?? '(none)' });
  } catch (err) {
    log.warn('could not init state repo (non-fatal)', { err: String(err) });
  }
}

/**
 * Commit the current state tree to `~/.sunny/state/` (runtime-home). Called right
 * after each serialized state write so history captures every change. Best-effort:
 * a missing repo, a no-op commit, or any git error is logged, never thrown, so a
 * state write never fails on persistence. Pushing is separate ({@link pushState}).
 */
export async function commitState(runtimeDir: string, message: string): Promise<void> {
  const dir = stateDir(runtimeDir);
  if (!isGitRepo(dir)) return;
  try {
    await exec('git', ['add', '-A'], { cwd: dir });
    await exec('git', ['commit', '-q', '-m', message], { cwd: dir });
  } catch (err) {
    // Includes the benign "nothing to commit" case (e.g. an idempotent re-write).
    log.debug('state commit no-op or failed (non-fatal)', { err: String(err) });
  }
}

/**
 * Push committed state to the private remote (runtime-home). Best-effort and
 * debounced onto the periodic skill-sync cadence (NOT per-write): a failed push
 * (offline, no upstream, rejected) is non-fatal and leaves commits local for the
 * next attempt. No-op when no remote is configured or the repo doesn't exist.
 */
export async function pushState(config: SunnyConfig): Promise<void> {
  const dir = stateDir(config.runtimeDir);
  if (!config.state.repo || !isGitRepo(dir)) return;
  try {
    // `-u origin HEAD` sets the upstream on the first successful push; subsequent
    // pushes are plain fast-forwards. A diverged remote rejects → logged, kept local.
    await exec('git', ['-C', dir, 'push', '--quiet', '-u', 'origin', 'HEAD']);
  } catch (err) {
    log.warn('could not push state (committed locally; will retry next cycle)', {
      err: String(err),
    });
  }
}
