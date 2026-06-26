import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../tests/factories.js';
import { stateDir } from '../config/index.js';
import { applyMemoryWrite, memoryPaths } from '../memory/index.js';
import { commitState, initStateRepo, pushState } from './index.js';

/** Init `~/.sunny/state` as a git repo with a committer identity (so commits work in
 *  any CI sandbox). Returns the state dir. */
function initStateGit(runtimeDir: string): string {
  const dir = stateDir(runtimeDir);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'sunny@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Sunny Test'], { cwd: dir });
  return dir;
}

function gitLog(dir: string): string {
  return execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
}

describe('commitState', () => {
  it('commits the current state tree to the state repo', async () => {
    const { runtimeDir } = makeConfig();
    const dir = initStateGit(runtimeDir);
    writeFileSync(join(dir, 'note.txt'), 'hello');

    await commitState(runtimeDir, 'state: test commit');

    expect(gitLog(dir)).toContain('state: test commit');
  });

  it('is a no-op (non-fatal) when the state dir is not a git repo', async () => {
    const { runtimeDir } = makeConfig();
    mkdirSync(stateDir(runtimeDir), { recursive: true });
    writeFileSync(join(stateDir(runtimeDir), 'note.txt'), 'hi');
    // No .git → must not throw.
    await expect(commitState(runtimeDir, 'noop')).resolves.toBeUndefined();
  });
});

describe('pushState', () => {
  it('does not throw and leaves the commit local when the remote is unreachable', async () => {
    // A configured-but-bogus remote: the commit must persist and push must not throw.
    const config = makeConfig({ state: { repo: 'file:///nonexistent-sunny-state-remote.git' } });
    const dir = initStateGit(config.runtimeDir);
    writeFileSync(join(dir, 'note.txt'), 'data');
    await commitState(config.runtimeDir, 'state: keep me');

    await expect(pushState(config)).resolves.toBeUndefined();
    // The commit is still in local history despite the failed push.
    expect(gitLog(dir)).toContain('state: keep me');
  });

  it('is a no-op when no remote is configured', async () => {
    const config = makeConfig(); // no state.repo
    initStateGit(config.runtimeDir);
    await expect(pushState(config)).resolves.toBeUndefined();
  });
});

describe('initStateRepo', () => {
  it('git-inits the state dir in place when there is no remote', async () => {
    const config = makeConfig();
    await initStateRepo(config);
    expect(existsSync(join(stateDir(config.runtimeDir), '.git'))).toBe(true);
  });

  it('is idempotent — an existing state repo is left intact', async () => {
    const config = makeConfig();
    const dir = initStateGit(config.runtimeDir);
    writeFileSync(join(dir, 'sentinel'), 'x');
    await commitState(config.runtimeDir, 'sentinel commit');

    await initStateRepo(config); // must not re-init / clobber

    expect(gitLog(dir)).toContain('sentinel commit');
  });
});

describe('memory commit-on-write (runtime-home)', () => {
  it('commits a memory edit to the state repo history', async () => {
    const config = makeConfig();
    const dir = initStateGit(config.runtimeDir);
    // Seed the memory dir so the first write has somewhere to land.
    mkdirSync(memoryPaths(config.runtimeDir).topicsDir, { recursive: true });

    await applyMemoryWrite(config, { file: 'USER', action: 'add', content: '- Likes tea' });

    const log = gitLog(dir);
    expect(log).toContain('memory: add USER.md');
    // The committed tree actually contains the edit.
    const tracked = execFileSync('git', ['show', 'HEAD:memory/USER.md'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(tracked).toContain('- Likes tea');
  });
});
