import { describe, expect, it } from 'vitest';
// The `skill` helper CLI (bundled into the skill-authoring seed) — pure helpers.
// The git/filesystem commands are exercised manually; here we lock down the slug +
// validation logic that mirrors src/skills/index.ts so the two stay consistent.
import {
  composeSkill,
  parseFrontmatter,
  sanitizeName,
  validate,
} from '../src/skills/seed-assets/skill.mjs';

describe('skill CLI helpers', () => {
  it('sanitizeName slugifies and blocks path traversal', () => {
    expect(sanitizeName('My Skill')).toBe('my-skill');
    expect(sanitizeName('  Deploy_Site!! ')).toBe('deploy_site');
    // `..` and slashes collapse to a hyphen — no traversal escapes the skills dir.
    expect(sanitizeName('../../etc/passwd')).toBe('etc-passwd');
    expect(() => sanitizeName('   ')).toThrow(/invalid skill name/);
    expect(() => sanitizeName('!!!')).toThrow(/invalid skill name/);
  });

  it('parseFrontmatter reads the leading --- block (quotes stripped)', () => {
    const fm = parseFrontmatter('---\nname: foo\ndescription: "does a thing"\n---\n\nbody');
    expect(fm).toMatchObject({ name: 'foo', description: 'does a thing' });
    expect(parseFrontmatter('no frontmatter here')).toEqual({});
  });

  it('validate requires name + description', () => {
    expect(validate('---\nname: foo\ndescription: bar\n---\nx').ok).toBe(true);
    expect(validate('---\nname: foo\n---\nx')).toMatchObject({
      ok: false,
      errors: ['missing frontmatter: description'],
    });
    expect(validate('---\ndescription: bar\n---\nx').errors).toContain('missing frontmatter: name');
  });

  it('composeSkill emits valid frontmatter that round-trips through validate', () => {
    const raw = composeSkill({ name: 'My Skill', description: 'line one\nline two', body: '  do it  ' });
    expect(raw).toContain('name: my-skill');
    // The description is collapsed to one line (frontmatter is single-line scalars).
    expect(raw).toContain('description: line one line two');
    expect(raw.endsWith('do it\n')).toBe(true);
    expect(validate(raw).ok).toBe(true);
  });
});
