import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dataDir, stateDir, type SunnyConfig } from '../config/index.js';
import { logger } from '../logger.js';

const log = logger('state');
const exec = promisify(execFile);

/**
 * The runtime home's two git-backed stores (runtime-home / runtime-home-data-split):
 *
 * - `~/.sunny/state/` — the CODE-WRITTEN record: `memory/` (core + `topics/`),
 *   `credentials.json` (`op://` references only, never values), `schedules/`, and
 *   `mcp.json`. Written only by the runtime's own code paths; the agent's file tools
 *   refuse it. Persistence is commit-on-write: `commitState` after each serialized
 *   state write, so history reflects every change with a truthful message. Foreign
 *   changes (e.g. dropped in via bash) are SURFACED as warnings, then still committed —
 *   never silently laundered, never dropped.
 *
 * - `~/.sunny/data/` — the AGENT-WRITTEN store: sites, projects, structured working
 *   state skills keep across runs. The agent just writes files; persistence is a
 *   periodic SWEEP (`sweepData`, `data: sweep`) on the same tick that pushes state,
 *   plus once at boot so a crash strands at most one interval of work.
 *
 * Both are SIBLINGS of the skill clones and `media/`, so no repo nests inside another's
 * tracked tree. All git steps are best-effort and non-fatal — offline leaves changes
 * committed locally; the next push catches up. Mirrors `commitSkillChange`/`syncSkillRepo`
 * in src/skills/index.ts.
 */

/** Expand a `config.state.repo`/`config.data.repo`/`config.skills.repo` value to a clone
 *  URL. Accepts `owner/repo` shorthand (→ GitHub HTTPS) or a full URL / local path passed
 *  through. (Kept in sync with `repoUrl` in src/skills/index.ts; duplicated to avoid
 *  coupling the state module to the skills module.) */
function cloneUrl(repo: string): string {
  return /^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\.{0,2}\/)/.test(repo)
    ? repo
    : `https://github.com/${repo}.git`;
}

/** Fixed committer identity for runtime commits (portability D12): persistence must
 *  work on a host with NO global git config — without this, every commit fails and
 *  memory silently stops being versioned. (Mirrored in src/skills/index.ts.) */
const GIT_IDENTITY = ['-c', 'user.name=Sunny', '-c', 'user.email=sunny@sunny.invalid'];

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

function isEmptyDir(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

/** `git status --porcelain` paths (rename lines yield the NEW path). Empty = clean.
 *  Best-effort: a git failure reports clean rather than throwing. */
async function dirtyPaths(dir: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: dir });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const p = line.slice(3);
        const arrow = p.indexOf(' -> ');
        return arrow === -1 ? p : p.slice(arrow + 4);
      });
  } catch {
    return [];
  }
}

/**
 * Ensure `dir` is a git repository backing one of the runtime-home stores. On a FRESH
 * host with a configured remote and an empty dir, clone it (so existing content comes
 * back). Otherwise `git init` in place, wire the remote when one is configured, and make
 * an initial commit. Divergence is handled best-effort (the periodic push reports
 * rejection); we never auto-merge untrusted history here. Best-effort and non-fatal —
 * a host with no git, no network, or partial content still boots and persists locally.
 */
async function initRepoAt(
  runtimeHome: string,
  dir: string,
  repo: string | undefined,
  label: string,
  seedMessage: string,
): Promise<void> {
  if (isGitRepo(dir)) return;
  try {
    if (repo && isEmptyDir(dir)) {
      // Fresh host: clone the private remote into place.
      mkdirSync(runtimeHome, { recursive: true });
      await exec('git', ['clone', '--quiet', cloneUrl(repo), dir]);
      log.info(`cloned ${label} repo`, { repo });
      return;
    }
    mkdirSync(dir, { recursive: true });
    await exec('git', ['init', '-q'], { cwd: dir });
    if (repo) {
      try {
        await exec('git', ['remote', 'add', 'origin', cloneUrl(repo)], { cwd: dir });
      } catch (err) {
        log.warn(`could not set ${label} remote (non-fatal)`, { err: String(err) });
      }
    }
    await exec('git', ['add', '-A'], { cwd: dir });
    try {
      await exec('git', [...GIT_IDENTITY, 'commit', '-q', '-m', seedMessage], { cwd: dir });
    } catch {
      /* nothing to commit yet — fine */
    }
    log.info(`initialized ${label} repo`, { remote: repo ?? '(none)' });
  } catch (err) {
    log.warn(`could not init ${label} repo (non-fatal)`, { err: String(err) });
  }
}

/** Commit everything outstanding in `dir`. Best-effort: a missing repo, a no-op commit,
 *  or any git error is logged, never thrown. */
async function commitRepoAt(dir: string, message: string): Promise<void> {
  if (!isGitRepo(dir)) return;
  try {
    await exec('git', ['add', '-A'], { cwd: dir });
    await exec('git', [...GIT_IDENTITY, 'commit', '-q', '-m', message], { cwd: dir });
  } catch (err) {
    // Includes the benign "nothing to commit" case (e.g. an idempotent re-write).
    log.debug('repo commit no-op or failed (non-fatal)', { dir, err: String(err) });
  }
}

/** Push `dir` to its configured remote. Best-effort and debounced onto the periodic
 *  sync cadence (NOT per-write): a failed push (offline, no upstream, rejected) is
 *  non-fatal and leaves commits local for the next attempt. No-op when no remote is
 *  configured or the repo doesn't exist. */
async function pushRepoAt(dir: string, hasRemote: boolean, label: string): Promise<void> {
  if (!hasRemote || !isGitRepo(dir)) return;
  try {
    // `-u origin HEAD` sets the upstream on the first successful push; subsequent
    // pushes are plain fast-forwards. A diverged remote rejects → logged, kept local.
    await exec('git', ['-C', dir, 'push', '--quiet', '-u', 'origin', 'HEAD']);
  } catch (err) {
    log.warn(`could not push ${label} (committed locally; will retry next cycle)`, {
      err: String(err),
    });
  }
}

/** Ensure `~/.sunny/state/` is a git repository (runtime-home). See {@link initRepoAt}. */
export async function initStateRepo(config: SunnyConfig): Promise<void> {
  await initRepoAt(
    config.runtimeDir,
    stateDir(config.runtimeDir),
    config.state.repo,
    'state',
    'seed state repo',
  );
}

/** Ensure `~/.sunny/data/` is a git repository (runtime-home-data-split). */
export async function initDataRepo(config: SunnyConfig): Promise<void> {
  await initRepoAt(
    config.runtimeDir,
    dataDir(config.runtimeDir),
    config.data.repo,
    'data',
    'seed data repo',
  );
}

/**
 * Commit the current state tree to `~/.sunny/state/` (runtime-home). Called right after
 * each serialized state write so history captures every change. Best-effort — a state
 * write never fails on persistence. Pushing is separate ({@link pushState}).
 *
 * `expectedPrefixes` names the paths this write is ALLOWED to have touched (e.g.
 * `['memory/']`): any other dirty path is a stray — the agent's tools refuse `state/`,
 * so a stray means a bash write or an outside edit. Strays are warned about loudly and
 * then still committed (surfaced, never laundered as this write; never dropped).
 */
export async function commitState(
  runtimeDir: string,
  message: string,
  expectedPrefixes?: readonly string[],
): Promise<void> {
  const dir = stateDir(runtimeDir);
  if (!isGitRepo(dir)) return;
  if (expectedPrefixes) {
    const strays = (await dirtyPaths(dir)).filter(
      (p) => !expectedPrefixes.some((prefix) => p.startsWith(prefix)),
    );
    if (strays.length > 0) {
      log.warn(
        'state repo has changes outside this write — ~/.sunny/state is code-managed; ' +
          'agent artifacts belong in ~/.sunny/data (committing them anyway, not dropping)',
        { strays, write: message },
      );
    }
  }
  await commitRepoAt(dir, message);
}

/** Boot-time integrity check (runtime-home-data-split): the state tree should be clean
 *  between writes. A dirty tree at startup means something wrote there outside the
 *  runtime's own code paths — warn loudly (naming the paths) before it gets absorbed
 *  into the next commit. */
export async function warnIfStateDirty(runtimeDir: string): Promise<void> {
  const dir = stateDir(runtimeDir);
  if (!isGitRepo(dir)) return;
  const dirty = await dirtyPaths(dir);
  if (dirty.length > 0) {
    log.warn(
      'state repo tree is dirty at boot — ~/.sunny/state is code-managed and should be ' +
        'clean between writes; these files were written outside the runtime',
      { paths: dirty },
    );
  }
}

/** Sweep-commit the data repo (runtime-home-data-split): commit everything the agent
 *  wrote since the last sweep. No-op when clean. Runs at boot and on the periodic
 *  push tick — the agent never runs git in `data/`. */
export async function sweepData(config: SunnyConfig): Promise<void> {
  await commitRepoAt(dataDir(config.runtimeDir), 'data: sweep');
}

/** Push committed state to the private remote (runtime-home). See {@link pushRepoAt}. */
export async function pushState(config: SunnyConfig): Promise<void> {
  await pushRepoAt(stateDir(config.runtimeDir), Boolean(config.state.repo), 'state');
}

/** Push the data repo to its private remote (runtime-home-data-split). */
export async function pushData(config: SunnyConfig): Promise<void> {
  await pushRepoAt(dataDir(config.runtimeDir), Boolean(config.data.repo), 'data');
}

/** Commit the data repo with an explicit message (migration use — sweeps use
 *  {@link sweepData}). */
export async function commitData(config: SunnyConfig, message: string): Promise<void> {
  await commitRepoAt(dataDir(config.runtimeDir), message);
}
