import { describe, it, expect } from 'vitest';
import { makeConfig } from '../../tests/factories.js';
import {
  composeSkill,
  deleteSkill,
  initSkills,
  loadSkillBody,
  loadSkillIndex,
  loadSkills,
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

  it('does not overwrite a user-edited seed', async () => {
    const config = makeConfig();
    const paths = skillsPaths(config.runtimeDir);
    await initSkills(config);

    await writeSkill(config, { name: 'email', description: 'my edit', body: 'custom' });
    await initSkills(config); // seed is present → left alone

    expect(loadSkillBody(paths, 'email')).toBe('custom');
  });
});
