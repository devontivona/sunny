import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeConfig } from '../../tests/factories.js';
import { dataDir, stateDir } from '../config/index.js';
import { applyMemoryWrite, memoryPaths } from '../memory/index.js';
import {
  commitState,
  initDataRepo,
  initStateRepo,
  pushData,
  pushState,
  sweepData,
  warnIfStateDirty,
} from './index.js';

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

  it('commits with the fixed runtime identity — no machine git config required (portability D12)', async () => {
    const { runtimeDir } = makeConfig();
    // Deliberately NO `git config user.*` here: a fresh host has none, and
    // persistence must still work (the -c identity flags carry it).
    const dir = stateDir(runtimeDir);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'note.txt'), 'hello');

    await commitState(runtimeDir, 'state: identity test');

    const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    expect(author).toBe('Sunny <sunny@sunny.invalid>');
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

describe('data repo (runtime-home-data-split)', () => {
  it('initDataRepo git-inits data/ in place and is idempotent', async () => {
    const config = makeConfig();
    await initDataRepo(config);
    const dir = dataDir(config.runtimeDir);
    expect(existsSync(join(dir, '.git'))).toBe(true);

    writeFileSync(join(dir, 'sentinel.txt'), 'x');
    await sweepData(config);
    await initDataRepo(config); // must not re-init / clobber
    expect(gitLog(dir)).toContain('data: sweep');
  });

  it('sweepData commits agent writes with the sweep message and no-ops when clean', async () => {
    const config = makeConfig();
    await initDataRepo(config);
    const dir = dataDir(config.runtimeDir);
    mkdirSync(join(dir, 'sites', 'demo'), { recursive: true });
    writeFileSync(join(dir, 'sites', 'demo', 'index.html'), '<h1>hi</h1>');

    await sweepData(config);
    await sweepData(config); // clean tree → no second commit

    const sweeps = gitLog(dir)
      .split('\n')
      .filter((l) => l.includes('data: sweep'));
    expect(sweeps).toHaveLength(1);
    const tracked = execFileSync('git', ['show', 'HEAD:sites/demo/index.html'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(tracked).toContain('<h1>hi</h1>');
  });

  it('pushData is a no-op without a remote and non-fatal with an unreachable one', async () => {
    const noRemote = makeConfig();
    await initDataRepo(noRemote);
    await expect(pushData(noRemote)).resolves.toBeUndefined();

    const bogus = makeConfig({ data: { repo: 'file:///nonexistent-sunny-data-remote.git' } });
    // Non-empty dir → init-in-place (an empty dir + remote would take the clone path,
    // which fails against the bogus remote and leaves no repo — a different scenario).
    mkdirSync(dataDir(bogus.runtimeDir), { recursive: true });
    writeFileSync(join(dataDir(bogus.runtimeDir), 'keep.txt'), 'v');
    await initDataRepo(bogus);
    writeFileSync(join(dataDir(bogus.runtimeDir), 'post-init.txt'), 'v');
    await sweepData(bogus);
    await expect(pushData(bogus)).resolves.toBeUndefined();
    // The failed push left the sweep commit local.
    expect(gitLog(dataDir(bogus.runtimeDir))).toContain('data: sweep');
  });
});

describe('commitState stray surfacing (runtime-home-data-split)', () => {
  it('warns on dirty paths outside the expected prefixes and still commits them', async () => {
    const { runtimeDir } = makeConfig();
    const dir = initStateGit(runtimeDir);
    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(join(dir, 'memory', 'USER.md'), '- fact');
    writeFileSync(join(dir, 'stray.json'), '{}');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await commitState(runtimeDir, 'memory: add USER.md', ['memory/']);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('changes outside this write'),
        expect.objectContaining({ strays: ['stray.json'] }),
      );
    } finally {
      warn.mockRestore();
    }
    // Surfaced, not dropped: the stray is committed anyway.
    const tracked = execFileSync('git', ['show', 'HEAD:stray.json'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(tracked).toBe('{}');
  });

  it('does not warn when only expected paths changed', async () => {
    const { runtimeDir } = makeConfig();
    const dir = initStateGit(runtimeDir);
    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(join(dir, 'memory', 'USER.md'), '- fact');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await commitState(runtimeDir, 'memory: add USER.md', ['memory/']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('warnIfStateDirty', () => {
  it('warns naming the dirty paths at boot', async () => {
    const { runtimeDir } = makeConfig();
    const dir = initStateGit(runtimeDir);
    writeFileSync(join(dir, 'dropped-by-bash.txt'), 'oops');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await warnIfStateDirty(runtimeDir);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('dirty at boot'),
        expect.objectContaining({ paths: ['dropped-by-bash.txt'] }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('is silent when the tree is clean', async () => {
    const { runtimeDir } = makeConfig();
    const dir = initStateGit(runtimeDir);
    writeFileSync(join(dir, 'note.txt'), 'v');
    await commitState(runtimeDir, 'seed');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await warnIfStateDirty(runtimeDir);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
