import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SunnyConfig } from '../config/index.js';
import { logger } from '../logger.js';

const log = logger('skills');
const exec = promisify(execFile);

/**
 * Agent-skills runtime (agent-skills D-SK1/2/7/8). Skills are agentskills.io
 * `SKILL.md` files under `~/.sunny/skills/<name>/`, inside the single `~/.sunny`
 * git repo (created by initMemory). Progressive disclosure mirrors the memory
 * core: only name + description are always-on (the index); a body loads on demand
 * via `loadSkillBody` (skill_manage view). Self-authored skills are validated,
 * written, and committed locally; pushing to a dedicated remote (D-SK8) needs git
 * creds and is deferred to the credentials/security work.
 */

export type TrustTier = 'authored' | 'installed';

export interface SkillRecord {
  name: string;
  description: string;
  trust: TrustTier;
  /** Absolute path to the skill's SKILL.md. */
  file: string;
  /** Provenance for installed skills (e.g. owner/repo), if declared. */
  source?: string;
}

export interface SkillsBudget {
  maxSkills: number;
  descriptionMaxChars: number;
}

export interface SkillsPaths {
  root: string;
  skillDir: (name: string) => string;
  skillFile: (name: string) => string;
}

export function skillsPaths(runtimeDir: string): SkillsPaths {
  const root = join(runtimeDir, 'skills');
  return {
    root,
    skillDir: (name: string) => join(root, sanitizeSkillName(name)),
    skillFile: (name: string) => join(root, sanitizeSkillName(name), 'SKILL.md'),
  };
}

/** Restrict skill names to a safe slug — prevents path traversal. */
export function sanitizeSkillName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`invalid skill name: ${name}`);
  return slug;
}

// --- parsing / validation --------------------------------------------------

export interface ParsedSkill {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Parse a SKILL.md: a leading `---` frontmatter block + markdown body. A minimal
 * scalar parser — enough for the fields the loader uses (name, description,
 * source). Nested/list YAML is ignored; the body passes through verbatim, since
 * the model consumes the body as-is and only the index needs structured fields.
 */
export function parseSkill(raw: string): ParsedSkill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw.trim() };
  const frontmatter: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    const key = kv?.[1];
    if (!key) continue;
    let value = (kv[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key.toLowerCase()] = value;
  }
  return { frontmatter, body: (m[2] ?? '').trim() };
}

export interface SkillValidation {
  ok: boolean;
  errors: string[];
}

/** Validate a SKILL.md against the minimal required schema (D-SK7). */
export function validateSkill(raw: string): SkillValidation {
  const errors: string[] = [];
  const { frontmatter } = parseSkill(raw);
  if (!frontmatter.name) errors.push('missing frontmatter: name');
  else {
    try {
      sanitizeSkillName(frontmatter.name);
    } catch {
      errors.push(`invalid name: ${frontmatter.name}`);
    }
  }
  if (!frontmatter.description) errors.push('missing frontmatter: description');
  return { ok: errors.length === 0, errors };
}

function trustOf(fm: Record<string, string>): TrustTier {
  return fm.source ? 'installed' : 'authored';
}

// --- loading (progressive disclosure) --------------------------------------

/** Read all valid skill records (name + description + trust), sorted by name.
 *  Skills failing validation are skipped (D-SK7) and logged. */
export function loadSkills(paths: SkillsPaths): SkillRecord[] {
  if (!existsSync(paths.root)) return [];
  const records: SkillRecord[] = [];
  for (const entry of readdirSync(paths.root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(paths.root, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const { frontmatter } = parseSkill(readFileSync(file, 'utf8'));
    if (!frontmatter.name || !frontmatter.description) {
      log.warn('skipping invalid skill (missing name/description)', { dir: entry.name });
      continue;
    }
    records.push({
      name: frontmatter.name,
      description: frontmatter.description,
      trust: trustOf(frontmatter),
      file,
      source: frontmatter.source,
    });
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

/** Render the always-on skills index (names + descriptions only). Deterministic
 *  (sorted, no timestamps) so the prompt prefix stays cache-stable like the
 *  memory core. Budget-capped: at most `maxSkills`, each description truncated. */
export function renderSkillIndex(records: SkillRecord[], budget: SkillsBudget): string {
  if (records.length === 0) return '';
  // Sort defensively so the index is byte-stable regardless of input order (the
  // prompt-cache invariant must not depend on the caller pre-sorting).
  const sorted = [...records].sort((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.slice(0, budget.maxSkills);
  const lines = shown.map((r) => {
    const desc =
      r.description.length > budget.descriptionMaxChars
        ? `${r.description.slice(0, budget.descriptionMaxChars - 1)}…`
        : r.description;
    return `- ${r.name}: ${desc}`;
  });
  if (records.length > shown.length) {
    lines.push(`- (+${records.length - shown.length} more not shown)`);
  }
  return lines.join('\n');
}

/** Read + render the always-on index in one call (used per-turn in the loop). */
export function loadSkillIndex(paths: SkillsPaths, budget: SkillsBudget): string {
  return renderSkillIndex(loadSkills(paths), budget);
}

/** Load one skill's body on demand (progressive disclosure; skill_manage view). */
export function loadSkillBody(paths: SkillsPaths, name: string): string | null {
  const file = paths.skillFile(name);
  if (!existsSync(file)) return null;
  return parseSkill(readFileSync(file, 'utf8')).body;
}

// --- self-authoring (serialized writer + local commit) ---------------------
// Skill-file mutations funnel through one promise chain so concurrent turns/jobs
// cannot corrupt a skill (mirrors the memory writer, agent-memory R7).
let writeChain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export interface WriteSkillInput {
  name: string;
  description: string;
  body: string;
}

/** Compose a SKILL.md (frontmatter + body) from fields. */
export function composeSkill(input: WriteSkillInput): string {
  const name = sanitizeSkillName(input.name);
  const description = input.description.trim().replace(/\s*\n\s*/g, ' ');
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${input.body.trim()}\n`;
}

/** Create/overwrite a self-authored skill: validate → write → commit (D-SK4/7/8). */
export function writeSkill(config: SunnyConfig, input: WriteSkillInput): Promise<string> {
  return serialize(async () => {
    const name = sanitizeSkillName(input.name);
    if (!input.description.trim()) throw new Error('description is required');
    if (!input.body.trim()) throw new Error('body is required');
    const raw = composeSkill(input);
    const v = validateSkill(raw);
    if (!v.ok) throw new Error(`invalid skill: ${v.errors.join('; ')}`);
    const paths = skillsPaths(config.runtimeDir);
    mkdirSync(paths.skillDir(name), { recursive: true });
    writeFileSync(paths.skillFile(name), raw, { mode: 0o644 });
    await commitSkillChange(config.runtimeDir, `skill: write ${name}`);
    return `ok: wrote skill "${name}" (${raw.length} chars). Tell ${config.owner.name} you created it.`;
  });
}

/** Delete a self-authored skill: remove → commit. */
export function deleteSkill(config: SunnyConfig, name: string): Promise<string> {
  return serialize(async () => {
    const slug = sanitizeSkillName(name);
    const dir = skillsPaths(config.runtimeDir).skillDir(slug);
    if (!existsSync(dir)) return `(no skill named "${slug}")`;
    rmSync(dir, { recursive: true, force: true });
    await commitSkillChange(config.runtimeDir, `skill: delete ${slug}`);
    return `ok: deleted skill "${slug}".`;
  });
}

/** Ensure the skills dir exists (the ~/.sunny git repo is created by initMemory). */
export function initSkills(config: SunnyConfig): void {
  mkdirSync(skillsPaths(config.runtimeDir).root, { recursive: true });
}

/** Commit a skill change to the ~/.sunny repo (D-SK8). Local only — pushing to a
 *  dedicated remote needs git creds (deferred to credentials/security). Non-fatal:
 *  a no-op commit (nothing changed) or a missing repo is logged, not thrown. */
async function commitSkillChange(runtimeDir: string, message: string): Promise<void> {
  if (!existsSync(join(runtimeDir, '.git'))) return;
  try {
    await exec('git', ['add', '-A', 'skills'], { cwd: runtimeDir });
    await exec('git', ['commit', '-q', '-m', message], { cwd: runtimeDir });
  } catch (err) {
    log.warn('could not commit skill change (non-fatal)', { err: String(err) });
  }
}
