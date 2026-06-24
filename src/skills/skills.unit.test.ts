import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { makeConfig } from '../../tests/factories.js';
import {
  composeSkill,
  deleteSkill,
  initSkills,
  loadAllSkills,
  loadSkillBody,
  loadSkillIndex,
  loadSkills,
  repoSlug,
  repoUrl,
  parseSkill,
  renderSkillIndex,
  sanitizeSkillName,
  skillsPaths,
  validateSkill,
  writeSkill,
  type SkillRecord,
} from './index.js';

const BUDGET = { maxSkills: 20, descriptionMaxChars: 280 };

function rec(name: string, description = `do ${name}`): SkillRecord {
  return { name, description, trust: 'authored', file: `/tmp/${name}/SKILL.md` };
}

describe('parseSkill', () => {
  it('splits frontmatter scalars from the body', () => {
    const { frontmatter, body } = parseSkill(
      `---\nname: deploy-site\ndescription: "ship the static site"\n---\n\nrun devbox up\n`,
    );
    expect(frontmatter.name).toBe('deploy-site');
    expect(frontmatter.description).toBe('ship the static site');
    expect(body).toBe('run devbox up');
  });

  it('treats a file with no frontmatter as a bare body', () => {
    const { frontmatter, body } = parseSkill('just instructions');
    expect(frontmatter).toEqual({});
    expect(body).toBe('just instructions');
  });
});

describe('validateSkill', () => {
  it('accepts a skill with name + description', () => {
    expect(validateSkill(`---\nname: a\ndescription: b\n---\nbody`).ok).toBe(true);
  });

  it('rejects missing required fields', () => {
    const v = validateSkill(`---\nname: a\n---\nbody`);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/description/);
  });
});

describe('sanitizeSkillName', () => {
  it('slugifies and blocks traversal', () => {
    expect(sanitizeSkillName('Deploy Site!')).toBe('deploy-site');
    expect(() => sanitizeSkillName('../../etc')).not.toThrow();
    expect(sanitizeSkillName('../../etc')).toBe('etc');
    expect(() => sanitizeSkillName('   ')).toThrow();
  });
});

describe('renderSkillIndex', () => {
  it('is deterministic and sorted by name', () => {
    const a = renderSkillIndex([rec('zed'), rec('alpha')], BUDGET);
    const b = renderSkillIndex([rec('alpha'), rec('zed')], BUDGET);
    expect(a).toBe(b);
    expect(a.indexOf('alpha')).toBeLessThan(a.indexOf('zed'));
  });

  it('caps the count and truncates long descriptions', () => {
    const many = Array.from({ length: 5 }, (_, i) => rec(`s${i}`));
    const out = renderSkillIndex(many, { maxSkills: 2, descriptionMaxChars: 280 });
    expect(out).toMatch(/\(\+3 more not shown\)/);

    const long = renderSkillIndex([rec('x', 'y'.repeat(500))], {
      maxSkills: 20,
      descriptionMaxChars: 10,
    });
    expect(long).toContain('…');
    expect(long.length).toBeLessThan(40);
  });

  it('renders empty for no skills', () => {
    expect(renderSkillIndex([], BUDGET)).toBe('');
  });
});

describe('composeSkill', () => {
  it('produces a valid, parseable SKILL.md', () => {
    const raw = composeSkill({ name: 'My Skill', description: 'a\n  b', body: '  steps  ' });
    expect(validateSkill(raw).ok).toBe(true);
    const { frontmatter, body } = parseSkill(raw);
    expect(frontmatter.name).toBe('my-skill');
    expect(frontmatter.description).toBe('a b'); // newlines collapsed
    expect(body).toBe('steps');
  });
});

describe('write / load / delete round-trip', () => {
  it('writes a skill, indexes it, loads its body, and deletes it', async () => {
    const config = makeConfig();
    const paths = skillsPaths(config.runtimeDir);

    expect(loadSkills(paths)).toEqual([]);

    const res = await writeSkill(config, {
      name: 'deploy-site',
      description: 'ship the static site with devbox',
      body: 'run devbox up and share the url',
    });
    expect(res).toMatch(/wrote skill "deploy-site"/);

    const records = loadSkills(paths);
    expect(records.map((r) => r.name)).toEqual(['deploy-site']);
    expect(records[0]?.trust).toBe('authored');

    const index = loadSkillIndex(paths, config.skills);
    expect(index).toContain('deploy-site: ship the static site with devbox');

    expect(loadSkillBody(paths, 'deploy-site')).toBe('run devbox up and share the url');
    expect(loadSkillBody(paths, 'nope')).toBeNull();

    const del = await deleteSkill(config, 'deploy-site');
    expect(del).toMatch(/deleted skill "deploy-site"/);
    expect(loadSkills(paths)).toEqual([]);
  });

  it('rejects an incomplete skill', async () => {
    const config = makeConfig();
    await expect(writeSkill(config, { name: 'x', description: '', body: 'b' })).rejects.toThrow(
      /description is required/,
    );
  });
});

describe('repoUrl', () => {
  it('expands owner/repo to a GitHub HTTPS url and passes full urls through', () => {
    expect(repoUrl('devontivona/skills')).toBe('https://github.com/devontivona/skills.git');
    expect(repoUrl('https://github.com/x/y.git')).toBe('https://github.com/x/y.git');
    expect(repoUrl('git@github.com:x/y.git')).toBe('git@github.com:x/y.git');
  });
});

describe('initSkills seeding', () => {
  it('seeds bundled skills on a fresh runtime, idempotently', async () => {
    const config = makeConfig();
    const paths = skillsPaths(config.runtimeDir);

    await initSkills(config);
    expect(loadSkills(paths).map((s) => s.name)).toContain('email');
    const after = loadSkills(paths).length;

    await initSkills(config); // running again seeds nothing new
    expect(loadSkills(paths).length).toBe(after);
  });

  it('seeds the browse skill with its reference assets', async () => {
    const config = makeConfig();
    const paths = skillsPaths(config.runtimeDir);

    await initSkills(config);

    const browse = loadSkills(paths).find((s) => s.name === 'browse');
    expect(browse?.description).toMatch(/agent-browser/);
    // Deeper engine + per-site docs travel with the skill (progressive disclosure).
    const dir = paths.skillDir('browse');
    expect(existsSync(join(dir, 'references/agent-browser.md'))).toBe(true);
    expect(existsSync(join(dir, 'references/per-site-skills.md'))).toBe(true);
  });

  it('does not overwrite a user-edited seed', async () => {
    const config = makeConfig();
    const paths = skillsPaths(config.runtimeDir);
    await initSkills(config);

    await writeSkill(config, { name: 'email', description: 'my edit', body: 'custom' });
    await initSkills(config); // seed is present → left alone

    expect(loadSkillBody(paths, 'email')).toBe('custom');
  });
});

describe('repoSlug', () => {
  it('slugifies repo refs and URLs to a stable clone dir name', () => {
    expect(repoSlug('devontivona/devbox')).toBe('devontivona-devbox');
    expect(repoSlug('https://github.com/devontivona/devbox.git')).toBe(
      'github.com-devontivona-devbox',
    );
    expect(() => repoSlug('')).toThrow(/invalid repo ref/);
  });
});

describe('loadAllSkills (multi-root owned repos)', () => {
  // Simulate cloned source repos by writing files directly into ~/.sunny/skill-sources/<slug>.
  // (loadAllSkills only reads the filesystem; git sync is exercised separately/manually.)
  function writeSkillFile(dir: string, name: string, description: string, body = 'do it') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    );
  }

  it('aggregates the primary + a single-skill repo + a collection repo, with provenance', async () => {
    const config = makeConfig({
      skills: { maxSkills: 20, descriptionMaxChars: 280, repos: ['owner/devbox', 'owner/pack'] },
    });
    // primary (self-authored, writable)
    await writeSkill(config, { name: 'mine', description: 'a primary skill', body: 'x' });
    const sources = join(config.runtimeDir, 'skill-sources');
    // single-skill repo: SKILL.md at the clone root
    writeSkillFile(join(sources, repoSlug('owner/devbox')), 'devbox', 'host sites');
    // collection repo: one skill per subdir
    writeSkillFile(join(sources, repoSlug('owner/pack'), 'alpha'), 'alpha', 'skill alpha');
    writeSkillFile(join(sources, repoSlug('owner/pack'), 'beta'), 'beta', 'skill beta');

    const all = loadAllSkills(config);
    const byName = new Map(all.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual(['alpha', 'beta', 'devbox', 'mine']);
    // owned sources carry their repo as provenance; the primary has none.
    expect(byName.get('devbox')?.source).toBe('owner/devbox');
    expect(byName.get('alpha')?.source).toBe('owner/pack');
    expect(byName.get('mine')?.source).toBeUndefined();
    // all owned → trusted (authored), never 'installed'.
    expect(all.every((s) => s.trust === 'authored')).toBe(true);
  });

  it('lets the primary win a name conflict with a source repo', async () => {
    const config = makeConfig({
      skills: { maxSkills: 20, descriptionMaxChars: 280, repos: ['owner/dup'] },
    });
    await writeSkill(config, { name: 'shared', description: 'primary version', body: 'p' });
    writeSkillFile(
      join(config.runtimeDir, 'skill-sources', repoSlug('owner/dup')),
      'shared',
      'source version',
    );
    const shared = loadAllSkills(config).filter((s) => s.name === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]?.description).toBe('primary version');
    expect(shared[0]?.source).toBeUndefined(); // the primary, not the source
  });
});
