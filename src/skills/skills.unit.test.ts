import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { makeConfig } from '../../tests/factories.js';
import {
  authoredRoot,
  composeSkill,
  deleteSkill,
  initSkills,
  isBuiltinSkill,
  loadAllSkills,
  loadBuiltinSkills,
  loadSkillBody,
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

// Isolate the builtin tier per test: point SUNNY_AGENT_DIR at a scratch dir so the
// REAL repo builtins (agent/builtin/skills) don't leak into fixture expectations.
// Tests that want the real shipped set clear the override explicitly.
let agentScratch: string;
beforeEach(() => {
  agentScratch = mkdtempSync(join(tmpdir(), 'sunny-agent-'));
  mkdirSync(join(agentScratch, 'builtin', 'skills'), { recursive: true });
  process.env.SUNNY_AGENT_DIR = agentScratch;
});
afterEach(() => {
  delete process.env.SUNNY_AGENT_DIR;
  rmSync(agentScratch, { recursive: true, force: true });
});

function writeBuiltin(name: string, description = `builtin ${name}`): void {
  const dir = join(agentScratch, 'builtin', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbuiltin body of ${name}\n`,
  );
}

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
  it('writes a skill (under authored/skills), indexes it, loads its body, and deletes it', async () => {
    const config = makeConfig();
    const paths = skillsPaths(config.runtimeDir);

    // Authored writes land in the nested spec location and are discovered from the
    // clone root via loadAllSkills (runtime-home); the write-root paths address the
    // individual skill file (loadSkillBody).
    expect(loadAllSkills(config)).toEqual([]);

    const res = await writeSkill(config, {
      name: 'deploy-site',
      description: 'ship the static site with devbox',
      body: 'run devbox up and share the url',
    });
    expect(res).toMatch(/wrote skill "deploy-site"/);
    // The file is written one level down, under the spec `skills/<name>/` location.
    expect(
      existsSync(join(authoredRoot(config.runtimeDir), 'skills', 'deploy-site', 'SKILL.md')),
    ).toBe(true);

    const records = loadAllSkills(config);
    expect(records.map((r) => r.name)).toEqual(['deploy-site']);
    expect(records[0]?.trust).toBe('authored');

    const index = renderSkillIndex(loadAllSkills(config), config.skills);
    expect(index).toContain('deploy-site: ship the static site with devbox');

    expect(loadSkillBody(paths, 'deploy-site')).toBe('run devbox up and share the url');
    expect(loadSkillBody(paths, 'nope')).toBeNull();

    const del = await deleteSkill(config, 'deploy-site');
    expect(del).toMatch(/deleted skill "deploy-site"/);
    expect(loadAllSkills(config)).toEqual([]);
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

describe('builtin skill tier (portability)', () => {
  it('loads builtins from the agent dir, trusted and read in place', async () => {
    const config = makeConfig();
    writeBuiltin('coding');
    await initSkills(config);

    const all = loadAllSkills(config);
    const coding = all.find((s) => s.name === 'coding');
    expect(coding?.trust).toBe('builtin');
    expect(coding?.file).toBe(join(agentScratch, 'builtin', 'skills', 'coding', 'SKILL.md'));
    // Never materialized: the authored write root stays empty.
    expect(readdirSync(skillsPaths(config.runtimeDir).root)).toEqual([]);

    await initSkills(config); // idempotent, still nothing materialized
    expect(readdirSync(skillsPaths(config.runtimeDir).root)).toEqual([]);
    expect(isBuiltinSkill('coding')).toBe(true);
    expect(isBuiltinSkill('nope')).toBe(false);
  });

  it('an authored skill with the same name shadows the builtin, annotated', async () => {
    const config = makeConfig();
    writeBuiltin('email', 'the shipped email skill');
    await initSkills(config);
    await writeSkill(config, { name: 'email', description: 'my email etiquette', body: 'custom' });

    const all = loadAllSkills(config);
    const email = all.filter((s) => s.name === 'email');
    expect(email).toHaveLength(1); // one entry per name
    expect(email[0]?.trust).toBe('authored');
    expect(email[0]?.shadowsBuiltin).toBe(true);
    expect(renderSkillIndex(all, BUDGET)).toContain('- email (your fork of a builtin):');
    // The fork is what loads; the builtin body is hidden until the fork is deleted.
    expect(loadSkillBody(skillsPaths(config.runtimeDir), 'email')).toBe('custom');
  });

  it('writeSkill/deleteSkill explain the fork lifecycle for builtin names', async () => {
    const config = makeConfig();
    writeBuiltin('browse');
    await initSkills(config);

    const wrote = await writeSkill(config, { name: 'browse', description: 'd', body: 'b' });
    expect(wrote).toMatch(/fork of the builtin/);

    const deleted = await deleteSkill(config, 'browse');
    expect(deleted).toMatch(/no longer shadowed/);

    // With no fork present, delete refuses and points at the fork path instead.
    const refused = await deleteSkill(config, 'browse');
    expect(refused).toMatch(/builtin skill/);
    expect(refused).toMatch(/code deploy/);
  });

  it('the REAL repo ships the full builtin set, machine-agnostic', () => {
    delete process.env.SUNNY_AGENT_DIR; // read the actual agent/builtin/skills
    // The builtin cut line: only skills that depend solely on surfaces that SHIP
    // with Sunny (native tools, the repo CLI, the skill system itself). Learned
    // capabilities riding host-installed tools (email/himalaya, browse/agent-browser,
    // website-builder/devbox) live in the authored skills repo instead.
    const names = loadBuiltinSkills().map((s) => s.name);
    expect(names).toEqual(['coding', 'delegation', 'dreaming', 'find-skills', 'skill-authoring']);
    // Builtin content must never embed a machine-specific path — the dreaming
    // skill addresses the repo via $SUNNY_REPO (portability D10).
    for (const rec of loadBuiltinSkills()) {
      const body = loadSkillBody(
        { root: '', skillDir: () => '', skillFile: () => rec.file },
        rec.name,
      );
      expect(body, `${rec.name} SKILL.md must not hardcode a home path`).not.toMatch(/\/home\//);
    }
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
  // Simulate cloned source repos by writing files directly into ~/.sunny/skills/trusted/<slug>.
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
    const sources = join(config.runtimeDir, 'skills', 'trusted');
    // single-skill repo: SKILL.md at the clone root
    writeSkillFile(join(sources, repoSlug('owner/devbox')), 'devbox', 'host sites');
    // collection repo: one skill per subdir under the spec `skills/<name>/` container
    writeSkillFile(
      join(sources, repoSlug('owner/pack'), 'skills', 'alpha'),
      'alpha',
      'skill alpha',
    );
    writeSkillFile(join(sources, repoSlug('owner/pack'), 'skills', 'beta'), 'beta', 'skill beta');

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

  it('reads a source repo that nests its skill in a `skills/<name>/` container', async () => {
    const config = makeConfig({
      skills: { maxSkills: 20, descriptionMaxChars: 280, repos: ['owner/devbox'] },
    });
    // devbox-style repo: SKILL.md lives at skills/devbox/SKILL.md alongside other files,
    // not at the repo root or one level down.
    const repoRoot = join(config.runtimeDir, 'skills', 'trusted', repoSlug('owner/devbox'));
    writeSkillFile(join(repoRoot, 'skills', 'devbox'), 'devbox', 'build/run/host projects');
    // Sibling non-skill files at the repo root must not confuse detection.
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'README.md'), '# devbox\n');

    const devbox = loadAllSkills(config).find((s) => s.name === 'devbox');
    expect(devbox?.trust).toBe('authored');
    expect(devbox?.source).toBe('owner/devbox');
  });

  it('does NOT load a root-level multi-skill layout (<name>/SKILL.md with no skills/ parent)', async () => {
    const config = makeConfig({
      skills: { maxSkills: 20, descriptionMaxChars: 280, repos: ['owner/legacy'] },
    });
    // A repo that drops skill folders directly at its root — the non-spec layout the
    // loader no longer recognizes (runtime-home D6).
    const repoRoot = join(config.runtimeDir, 'skills', 'trusted', repoSlug('owner/legacy'));
    writeSkillFile(join(repoRoot, 'rootlevel'), 'rootlevel', 'should not load');
    // A single-skill repo (SKILL.md at the root) and the nested layout still load.
    writeSkillFile(join(repoRoot, 'skills', 'nested'), 'nested', 'should load');

    const names = loadAllSkills(config).map((s) => s.name);
    expect(names).toContain('nested');
    expect(names).not.toContain('rootlevel');
  });

  it('lets the primary win a name conflict with a source repo', async () => {
    const config = makeConfig({
      skills: { maxSkills: 20, descriptionMaxChars: 280, repos: ['owner/dup'] },
    });
    await writeSkill(config, { name: 'shared', description: 'primary version', body: 'p' });
    writeSkillFile(
      join(config.runtimeDir, 'skills', 'trusted', repoSlug('owner/dup')),
      'shared',
      'source version',
    );
    const shared = loadAllSkills(config).filter((s) => s.name === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]?.description).toBe('primary version');
    expect(shared[0]?.source).toBeUndefined(); // the primary, not the source
  });

  it('classifies skills under installed/ as untrusted, by location (not frontmatter)', async () => {
    const config = makeConfig();
    // A self-authored skill in the primary (authored) root.
    await writeSkill(config, { name: 'mine', description: 'a primary skill', body: 'x' });
    // A third-party skill dropped into installed/ — as `npx skills add` would land it.
    // Note: NO `source:` frontmatter — trust must come from the location, not the file.
    writeSkillFile(
      join(config.runtimeDir, 'skills', 'installed', 'third-party'),
      'third-party',
      'came from npx skills',
    );

    const byName = new Map(loadAllSkills(config).map((s) => [s.name, s]));
    expect(byName.get('mine')?.trust).toBe('authored');
    expect(byName.get('third-party')?.trust).toBe('installed');
  });

  it('finds third-party skills in the nested `npx skills` layout under installed/', async () => {
    const config = makeConfig();
    // `npx skills add ... -a claude-code --copy` (run from installed/) lands skills at
    // installed/<agent-dir>/skills/<name>/SKILL.md and writes a skills-lock.json alongside.
    writeSkillFile(
      join(config.runtimeDir, 'skills', 'installed', '.claude', 'skills', 'deploy-to-vercel'),
      'deploy-to-vercel',
      'deploy apps to Vercel',
    );
    // The CLI's own lockfile must not be mistaken for a skill.
    writeFileSync(
      join(config.runtimeDir, 'skills', 'installed', 'skills-lock.json'),
      '{"version":1,"skills":{}}',
    );

    const rec = loadAllSkills(config).find((s) => s.name === 'deploy-to-vercel');
    expect(rec?.trust).toBe('installed');
  });

  it('lets an authored skill win a name conflict with an installed one', async () => {
    const config = makeConfig();
    await writeSkill(config, { name: 'dup', description: 'authored version', body: 'a' });
    writeSkillFile(
      join(config.runtimeDir, 'skills', 'installed', 'dup'),
      'dup',
      'installed version',
    );
    const dup = loadAllSkills(config).filter((s) => s.name === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0]?.trust).toBe('authored');
    expect(dup[0]?.description).toBe('authored version');
  });
});
