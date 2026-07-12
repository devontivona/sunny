import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../tests/factories.js';
import { dataDir, sitesDir, stateDir, type SunnyConfig } from '../config/index.js';
import { initDataRepo } from './index.js';
import { migrateAgentArtifactsToData } from './migrateData.js';

const DAY_MS = 24 * 60 * 60_000;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function ageFile(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
}

/** A populated pre-split host: a committed state repo holding reserved entries PLUS
 *  agent artifacts (sites, an ad-hoc skill dir, a stray root file), and a legacy
 *  `~/.sunny/sites/` with one new slug and two colliding ones. */
async function seedHost(config: SunnyConfig): Promise<{ state: string; legacy: string }> {
  const state = stateDir(config.runtimeDir);
  // Reserved entries.
  mkdirSync(join(state, 'memory'), { recursive: true });
  writeFileSync(join(state, 'memory', 'USER.md'), '- fact');
  writeFileSync(join(state, 'credentials.json'), '{}');
  mkdirSync(join(state, 'schedules'), { recursive: true });
  writeFileSync(join(state, 'schedules', 'daily.md'), 'schedule');
  writeFileSync(join(state, 'mcp.json'), '{}');
  // Agent artifacts stranded in state/.
  mkdirSync(join(state, 'sites', 'espresso'), { recursive: true });
  writeFileSync(join(state, 'sites', 'espresso', 'index.html'), 'state-espresso');
  mkdirSync(join(state, 'sites', 'terminal'), { recursive: true });
  writeFileSync(join(state, 'sites', 'terminal', 'index.html'), 'state-terminal');
  mkdirSync(join(state, 'task-assistant'), { recursive: true });
  writeFileSync(join(state, 'task-assistant', 'history.json'), '[]');
  writeFileSync(join(state, 'stray.json'), '{}');
  git(state, 'init', '-q');
  git(state, 'config', 'user.email', 'sunny@test');
  git(state, 'config', 'user.name', 'Sunny Test');
  git(state, 'add', '-A');
  git(state, 'commit', '-q', '-m', 'pre-split state');

  // Legacy ~/.sunny/sites: one new slug, two collisions with controlled recency.
  const legacy = join(config.runtimeDir, 'sites');
  mkdirSync(join(legacy, 'dogs'), { recursive: true });
  writeFileSync(join(legacy, 'dogs', 'index.html'), 'legacy-dogs');
  mkdirSync(join(legacy, 'espresso'), { recursive: true });
  writeFileSync(join(legacy, 'espresso', 'index.html'), 'legacy-espresso');
  mkdirSync(join(legacy, 'terminal'), { recursive: true });
  writeFileSync(join(legacy, 'terminal', 'index.html'), 'legacy-terminal');
  // espresso: LEGACY newer (state copy is old). terminal: LEGACY older (state copy is new).
  ageFile(join(state, 'sites', 'espresso', 'index.html'), 10 * DAY_MS);
  ageFile(join(legacy, 'terminal', 'index.html'), 10 * DAY_MS);

  await initDataRepo(config);
  return { state, legacy };
}

describe('migrateAgentArtifactsToData (runtime-home-data-split)', () => {
  it('relocates every non-reserved state entry and the legacy sites into data/', async () => {
    const config = makeConfig();
    const { state, legacy } = await seedHost(config);

    await migrateAgentArtifactsToData(config);

    const data = dataDir(config.runtimeDir);
    // Arrivals, content intact.
    expect(readFileSync(join(data, 'task-assistant', 'history.json'), 'utf8')).toBe('[]');
    expect(readFileSync(join(data, 'stray.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(sitesDir(config.runtimeDir), 'dogs', 'index.html'), 'utf8')).toBe(
      'legacy-dogs',
    );
    // Reserved set untouched.
    expect(readFileSync(join(state, 'memory', 'USER.md'), 'utf8')).toBe('- fact');
    expect(existsSync(join(state, 'credentials.json'))).toBe(true);
    expect(existsSync(join(state, 'schedules', 'daily.md'))).toBe(true);
    expect(existsSync(join(state, 'mcp.json'))).toBe(true);
    // Departures: no artifacts left in state/, no legacy dir left behind.
    expect(existsSync(join(state, 'sites'))).toBe(false);
    expect(existsSync(join(state, 'task-assistant'))).toBe(false);
    expect(existsSync(join(state, 'stray.json'))).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    // The state repo records the removal in a dedicated commit and ends clean.
    expect(git(state, 'log', '--oneline')).toContain(
      'migrate: relocate agent artifacts to ~/.sunny/data',
    );
    expect(git(state, 'status', '--porcelain')).toBe('');
    // The data repo committed the arrivals and ends clean too.
    expect(git(data, 'log', '--oneline')).toContain('migrate: relocate agent artifacts from state');
    expect(git(data, 'status', '--porcelain')).toBe('');
  });

  it('slug collisions: the newest copy wins the tree, the older survives in history', async () => {
    const config = makeConfig();
    await seedHost(config);

    await migrateAgentArtifactsToData(config);

    const data = dataDir(config.runtimeDir);
    const sites = sitesDir(config.runtimeDir);
    // espresso: legacy was newer → legacy in the working tree, state copy in history.
    expect(readFileSync(join(sites, 'espresso', 'index.html'), 'utf8')).toBe('legacy-espresso');
    // terminal: state copy was newer → state copy in the tree, legacy copy in history.
    expect(readFileSync(join(sites, 'terminal', 'index.html'), 'utf8')).toBe('state-terminal');

    for (const [slug, older] of [
      ['espresso', 'state-espresso'],
      ['terminal', 'legacy-terminal'],
    ] as const) {
      const hash = git(
        data,
        'log',
        '--all',
        '--format=%H',
        '--grep',
        `preserve older copy of site ${slug}`,
      ).trim();
      expect(hash).not.toBe('');
      expect(git(data, 'show', `${hash}:sites/${slug}/index.html`)).toBe(older);
    }
  });

  it('re-running is a no-op', async () => {
    const config = makeConfig();
    const { state } = await seedHost(config);
    await migrateAgentArtifactsToData(config);

    const data = dataDir(config.runtimeDir);
    const stateLog = git(state, 'log', '--oneline');
    const dataLog = git(data, 'log', '--oneline');

    await migrateAgentArtifactsToData(config);

    expect(git(state, 'log', '--oneline')).toBe(stateLog);
    expect(git(data, 'log', '--oneline')).toBe(dataLog);
  });

  it('is a no-op on a clean post-split host (nothing to migrate)', async () => {
    const config = makeConfig();
    const state = stateDir(config.runtimeDir);
    mkdirSync(join(state, 'memory'), { recursive: true });
    writeFileSync(join(state, 'memory', 'USER.md'), '- fact');
    git(state, 'init', '-q');
    // Pre-populate data/ so the init makes its seed commit (git log needs a HEAD).
    mkdirSync(dataDir(config.runtimeDir), { recursive: true });
    writeFileSync(join(dataDir(config.runtimeDir), 'seed.txt'), 'v');
    await initDataRepo(config);

    await expect(migrateAgentArtifactsToData(config)).resolves.toBeUndefined();
    // No migration commits appear anywhere.
    expect(git(dataDir(config.runtimeDir), 'log', '--oneline', '--all')).not.toContain('migrate:');
  });
});
