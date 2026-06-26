import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SunnyConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { SEED_SKILLS } from './seeds.js';

const log = logger('skills');
const exec = promisify(execFile);

/**
 * Agent-skills runtime (agent-skills D-SK1/2/7/8). Skills are agentskills.io
 * `SKILL.md` files read across three roots under `~/.sunny/skills/`, classified BY
 * LOCATION (D-SK5): `authored/` (self-authored + curated seeds, the canonical-repo
 * clone — trusted), `trusted/<slug>/` (owned source-repo mirrors — trusted), and
 * `installed/` (third-party `npx skills` installs — untrusted). Progressive disclosure mirrors the memory
 * core: only name + description are always-on (the index); a body is read on demand
 * (file_read on its SKILL.md). Self-authored skills are validated and
 * written, then committed and pushed to the canonical skill repo (D-SK8) when one
 * is configured (`config.skills.repo`); `~/.sunny/skills` is a clone of it, synced
 * on init. Git access uses the host's own auth (e.g. the gh credential helper).
 */

export type TrustTier = 'authored' | 'installed';

export interface SkillRecord {
  name: string;
  description: string;
  trust: TrustTier;
  /** Absolute path to the skill's SKILL.md. */
  file: string;
  /** Provenance: the owned source repo it came from (e.g. owner/repo), or an explicit
   *  frontmatter `source`. Undefined for primary self-authored skills. */
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

function pathsForRoot(root: string): SkillsPaths {
  return {
    root,
    skillDir: (name: string) => join(root, sanitizeSkillName(name)),
    skillFile: (name: string) => join(root, sanitizeSkillName(name), 'SKILL.md'),
  };
}

/** The authored tier's CLONE/repository root: `~/.sunny/skills/authored` (D-SK8,
 *  runtime-home) — a clone of the canonical skills repo, and the cwd for its git
 *  operations (sync/commit/push). The repo uses the spec layout, so the SKILL.md
 *  files live one level down under `skills/` (see {@link skillsPaths}). The loader
 *  scans this root and nested-detects `skills/<name>/`. */
export function authoredRoot(runtimeDir: string): string {
  return join(runtimeDir, 'skills', 'authored');
}

/** Paths for the PRIMARY (writable) skill root: `~/.sunny/skills/authored/skills`
 *  (D-SK8, runtime-home). The canonical repo packages skills under a top-level
 *  `skills/<name>/SKILL.md` so other agents can `npx skills add` it, so self-authored
 *  skills are WRITTEN here (committed + pushed from the clone root {@link authoredRoot}). */
export function skillsPaths(runtimeDir: string): SkillsPaths {
  return pathsForRoot(join(authoredRoot(runtimeDir), 'skills'));
}

/** Directory holding read-only clones of additional owned skill repos (D-SK8):
 *  `~/.sunny/skills/trusted/<slug>`. Owner-owned mirrors — trusted tier, distinct
 *  provenance from `authored` (which Sunny writes). */
function sourcesDir(runtimeDir: string): string {
  return join(runtimeDir, 'skills', 'trusted');
}

/** Root for third-party skills installed via `npx skills` (D-SK5): `~/.sunny/skills/installed`.
 *  UNTRUSTED — classified by location, so any install (even raw `npx skills add` over bash)
 *  that lands here is marked untrusted regardless of how it got there. */
function installedDir(runtimeDir: string): string {
  return join(runtimeDir, 'skills', 'installed');
}

/** Slugify a repo ref (owner/repo or URL) into a stable clone-directory name. */
export function repoSlug(repo: string): string {
  const slug = repo
    .replace(/^(https?:\/\/|git@)/, '')
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (!slug) throw new Error(`invalid repo ref: ${repo}`);
  return slug;
}

function sourceRoot(runtimeDir: string, repo: string): string {
  return join(sourcesDir(runtimeDir), repoSlug(repo));
}

/** The clean-layout skill roots (each a git repo with a single-skill or collection layout),
 *  in precedence order: the writable primary (`authored`) first, then each owned read-only
 *  source repo (`trusted/<slug>`). `origin` is the repo ref (provenance; undefined = primary).
 *  `trust` is decided BY ROOT (by on-disk location), not from frontmatter. The `installed/`
 *  third-party root is handled separately (`loadInstalledSkills`) because `npx skills` nests
 *  its output under an agent dir rather than the flat repo layout (D-SK5/D-SK8). */
function skillRoots(
  config: SunnyConfig,
): { paths: SkillsPaths; origin?: string; trust: TrustTier }[] {
  const roots: { paths: SkillsPaths; origin?: string; trust: TrustTier }[] = [
    // The authored tier is loaded from its CLONE root (the repo root), so the loader
    // nested-detects `skills/<name>/` — the spec layout the repo is packaged in.
    { paths: pathsForRoot(authoredRoot(config.runtimeDir)), trust: 'authored' },
  ];
  for (const repo of config.skills.repos ?? []) {
    roots.push({
      paths: pathsForRoot(sourceRoot(config.runtimeDir, repo)),
      origin: repo,
      trust: 'authored',
    });
  }
  return roots;
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

// --- loading (progressive disclosure) --------------------------------------

/** Read a record from one SKILL.md path, or null if missing/invalid (D-SK7). `trust` is the
 *  owning root's tier (by location, not frontmatter — D-SK5). `origin` (a repo ref) is recorded
 *  as provenance when the skill has no explicit frontmatter source. */
function readSkillRecord(file: string, trust: TrustTier, origin?: string): SkillRecord | null {
  if (!existsSync(file)) return null;
  const { frontmatter } = parseSkill(readFileSync(file, 'utf8'));
  if (!frontmatter.name || !frontmatter.description) {
    log.warn('skipping invalid skill (missing name/description)', { file });
    return null;
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    trust,
    file,
    source: frontmatter.source ?? origin,
  };
}

/** Read all valid skill records from ONE clean-layout repo root, sorted by name.
 *  Recognizes exactly the two spec layouts (runtime-home): a single-skill repo (a
 *  `SKILL.md` at the root) and a multi-skill repo (`skills/<name>/SKILL.md`). Skill
 *  folders placed directly at the repo root (`<name>/SKILL.md` with no `skills/`
 *  parent) are NOT recognized — that arrangement isn't part of the spec. `trust` is
 *  the root's tier (by location); `origin` marks provenance for owned sources. The
 *  `installed/` tier is loaded separately ({@link loadInstalledSkills}). */
export function loadSkills(
  paths: SkillsPaths,
  trust: TrustTier = 'authored',
  origin?: string,
): SkillRecord[] {
  if (!existsSync(paths.root)) return [];
  const records: SkillRecord[] = [];
  // Single-skill repo: SKILL.md directly at the repo root.
  const rootSkill = join(paths.root, 'SKILL.md');
  if (existsSync(rootSkill)) {
    const rec = readSkillRecord(rootSkill, trust, origin);
    if (rec) records.push(rec);
  } else {
    // Multi-skill repo: one skill per subdirectory inside the conventional `skills/`
    // container (`skills/<name>/SKILL.md`, the agentskills.io / `npx skills` layout),
    // so a repo can ship its skills alongside other files.
    const skillsContainer = join(paths.root, 'skills');
    if (existsSync(skillsContainer)) {
      for (const entry of readdirSync(skillsContainer, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '.git') continue;
        const rec = readSkillRecord(join(skillsContainer, entry.name, 'SKILL.md'), trust, origin);
        if (rec) records.push(rec);
      }
    }
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

/** How deep to walk the `installed/` root for SKILL.md files. `npx skills` nests them at
 *  `installed/<agent-dir>/skills/<name>/SKILL.md` (depth 4); the bound is a runaway guard. */
const INSTALLED_WALK_MAX_DEPTH = 6;

/** Read third-party skills from the `installed/` root (D-SK5). Unlike the clean repo roots,
 *  `npx skills` writes a nested `<agent-dir>/skills/<name>/SKILL.md` layout, so we walk for
 *  SKILL.md files at any depth. Every record is UNTRUSTED purely by virtue of living here —
 *  so even a raw `npx skills add` over bash that lands here is classified untrusted, with no
 *  manifest to keep in sync. Deduped by skill name (first found wins). */
function loadInstalledSkills(root: string): SkillRecord[] {
  if (!existsSync(root)) return [];
  const out: SkillRecord[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > INSTALLED_WALK_MAX_DEPTH) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.name === 'SKILL.md') {
        const rec = readSkillRecord(p, 'installed');
        if (rec && !seen.has(rec.name)) {
          seen.add(rec.name);
          out.push(rec);
        }
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read skills across ALL roots (authored primary + trusted owned sources + installed
 *  third-party), deduped by name with earlier (higher-trust) roots winning, sorted by
 *  name. This is what the prompt index and dashboard use. */
export function loadAllSkills(config: SunnyConfig): SkillRecord[] {
  const seen = new Set<string>();
  const out: SkillRecord[] = [];
  for (const { paths, origin, trust } of skillRoots(config)) {
    for (const rec of loadSkills(paths, trust, origin)) {
      if (seen.has(rec.name)) continue; // earlier roots (authored) win on conflict
      seen.add(rec.name);
      out.push(rec);
    }
  }
  // Third-party installs come last: authored/trusted skills win a name conflict, and a
  // third-party skill can never shadow one Sunny owns.
  for (const rec of loadInstalledSkills(installedDir(config.runtimeDir))) {
    if (seen.has(rec.name)) continue;
    seen.add(rec.name);
    out.push(rec);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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

/** Load one skill's body on demand (progressive disclosure; e.g. dashboard detail). */
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
    await commitSkillChange(config, `skill: write ${name}`);
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
    await commitSkillChange(config, `skill: delete ${slug}`);
    return `ok: deleted skill "${slug}".`;
  });
}

/** Expand a `config.skills.repo` value to a clone URL. Accepts `owner/repo`
 *  shorthand (→ GitHub HTTPS), or a full URL / local path passed through as-is
 *  (`https://`, `git@`, `ssh://`, `file://`, or an absolute / `./` path). */
export function repoUrl(repo: string): string {
  return /^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\.{0,2}\/)/.test(repo)
    ? repo
    : `https://github.com/${repo}.git`;
}

/** Outcome of a skill-repo sync, so callers (startup, the periodic syncer) can act
 *  — e.g. notify the owner on divergence. */
export type SkillSyncResult =
  | { status: 'cloned' }
  | { status: 'pulled'; commits: number }
  | { status: 'up-to-date'; aheadUnpushed: number }
  | { status: 'diverged'; ahead: number; behind: number }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; detail: string };

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', root, ...args]);
  return stdout.trim();
}

/**
 * Sync the canonical skill repo into `~/.sunny/skills` (D-SK8): clone on a fresh
 * host; otherwise `fetch` + **fast-forward only**. We never auto-merge or rebase —
 * if local self-authored commits and remote have diverged, we report `diverged`
 * and leave the working copy untouched (the owner resolves it), rather than have an
 * agent reconcile untrusted history. Best-effort: offline/no-repo is non-fatal and
 * Sunny falls back to the local copy. Host git auth provides access; no `op://`.
 */
async function syncSkillRepo(config: SunnyConfig): Promise<SkillSyncResult> {
  const repo = config.skills.repo;
  if (!repo) return { status: 'skipped', reason: 'no skills.repo configured' };
  const root = authoredRoot(config.runtimeDir);
  try {
    if (!existsSync(join(root, '.git'))) {
      if (existsSync(root) && readdirSync(root).length > 0) {
        return { status: 'skipped', reason: 'skills dir has content but is not a clone' };
      }
      mkdirSync(dirname(root), { recursive: true });
      await exec('git', ['clone', '--quiet', repoUrl(repo), root]);
      log.info('cloned skill repo', { repo });
      return { status: 'cloned' };
    }
    await git(root, ['fetch', '--quiet']);
    let upstream: string;
    try {
      upstream = await git(root, ['rev-parse', '--abbrev-ref', '@{u}']);
    } catch {
      return { status: 'skipped', reason: 'no upstream tracking branch' };
    }
    const behind = Number(await git(root, ['rev-list', '--count', '@..@{u}']));
    const ahead = Number(await git(root, ['rev-list', '--count', '@{u}..@']));
    if (behind === 0) return { status: 'up-to-date', aheadUnpushed: ahead };
    if (ahead > 0) {
      log.warn('skill repo diverged — leaving local copy untouched', { repo, ahead, behind });
      return { status: 'diverged', ahead, behind };
    }
    await git(root, ['merge', '--ff-only', '--quiet', upstream]);
    log.info('pulled skill repo', { repo, commits: behind });
    return { status: 'pulled', commits: behind };
  } catch (err) {
    log.warn('skill repo sync failed (non-fatal; using local copy)', { err: String(err) });
    return { status: 'error', detail: String(err) };
  }
}

/**
 * Sync one OWNED, read-only source repo into `~/.sunny/skills/trusted/<slug>` (D-SK8):
 * clone if absent, else `fetch` + **fast-forward only**. Sunny never writes to these,
 * so they should always ff cleanly; a non-ff (someone hand-edited the clone) is left
 * untouched and logged. Best-effort and non-fatal.
 */
async function syncSourceRepo(repo: string, root: string): Promise<SkillSyncResult> {
  try {
    if (!existsSync(join(root, '.git'))) {
      if (existsSync(root) && readdirSync(root).length > 0) {
        return { status: 'skipped', reason: 'source dir has content but is not a clone' };
      }
      mkdirSync(dirname(root), { recursive: true });
      await exec('git', ['clone', '--quiet', repoUrl(repo), root]);
      log.info('cloned source skill repo', { repo });
      return { status: 'cloned' };
    }
    await git(root, ['fetch', '--quiet']);
    let upstream: string;
    try {
      upstream = await git(root, ['rev-parse', '--abbrev-ref', '@{u}']);
    } catch {
      return { status: 'skipped', reason: 'no upstream tracking branch' };
    }
    const behind = Number(await git(root, ['rev-list', '--count', '@..@{u}']));
    const ahead = Number(await git(root, ['rev-list', '--count', '@{u}..@']));
    if (behind === 0) return { status: 'up-to-date', aheadUnpushed: ahead };
    if (ahead > 0) {
      log.warn('source skill repo has local edits — leaving untouched', { repo, ahead, behind });
      return { status: 'diverged', ahead, behind };
    }
    await git(root, ['merge', '--ff-only', '--quiet', upstream]);
    log.info('pulled source skill repo', { repo, commits: behind });
    return { status: 'pulled', commits: behind };
  } catch (err) {
    log.warn('source skill repo sync failed (non-fatal)', { repo, err: String(err) });
    return { status: 'error', detail: String(err) };
  }
}

/** Sync every configured owned source repo (best-effort). */
async function syncSourceRepos(config: SunnyConfig): Promise<void> {
  for (const repo of config.skills.repos ?? []) {
    await syncSourceRepo(repo, sourceRoot(config.runtimeDir, repo));
  }
}

/** How often the background syncer pulls the canonical skill repo. */
const SKILL_SYNC_MS = 10 * 60_000; // every 10 min — reads are live so the next turn sees updates

/**
 * Start a periodic skill-repo sync (option #1). `initSkills` already synced once at
 * startup, so this is the ongoing cadence (every 10 min). ff-only; on `diverged` it calls
 * `onDiverged` ONCE per divergence episode (reset when it clears) so the owner is
 * told but not spammed hourly. Reads are live, so a successful pull is picked up by
 * the next turn without a restart.
 */
export function startSkillSync(deps: {
  config: SunnyConfig;
  onDiverged?: (detail: string) => void;
  /** Best-effort work to run on each tick — e.g. the `state` repo push, batched onto
   *  this cadence rather than per-write (runtime-home, task 2.4). Failures are the
   *  callback's own concern; they never interrupt the skill sync. */
  onTick?: () => Promise<void>;
}): void {
  let warnedDiverged = false;
  async function tick(): Promise<void> {
    if (deps.onTick) {
      try {
        await deps.onTick();
      } catch (err) {
        log.warn('skill-sync onTick failed (non-fatal)', { err: String(err) });
      }
    }
    const r = await syncSkillRepo(deps.config);
    if (r.status === 'diverged') {
      if (!warnedDiverged) {
        warnedDiverged = true;
        deps.onDiverged?.(
          `Heads up — your skills repo and my local copy have diverged ` +
            `(${r.ahead} local, ${r.behind} remote commit(s)), so I've stopped auto-pulling skills ` +
            `until it's reconciled. Local skills still work; new repo changes won't land until you fix it.`,
        );
      }
    } else if (r.status !== 'error') {
      warnedDiverged = false;
    }
    // Owned read-only source repos: ff-sync each (no divergence notify — they're mirrors).
    await syncSourceRepos(deps.config);
  }
  setInterval(() => void tick(), SKILL_SYNC_MS);
  log.info('skill sync started', {
    everyMs: SKILL_SYNC_MS,
    sources: (deps.config.skills.repos ?? []).length,
  });
}

/** Ensure the skills dir exists, sync the canonical repo (D-SK8), then write any
 *  missing bundled seed skills as a FALLBACK (D-SK5) — the repo's versions win;
 *  bundled seeds only fill gaps. Seeds/edits are committed (and pushed) so Sunny's
 *  improvements round-trip to the canonical repo. */
export async function initSkills(config: SunnyConfig): Promise<void> {
  // The skill tiers are siblings under `~/.sunny/skills/` (runtime-home). Create the
  // container + the third-party install root (so `npx skills` has somewhere to land
  // and the loader has a stable untrusted root to scan, even before anything installs).
  mkdirSync(join(config.runtimeDir, 'skills'), { recursive: true });
  mkdirSync(installedDir(config.runtimeDir), { recursive: true });
  // Clone the canonical repo into `authored/` FIRST, while it's still empty (cloning
  // into a non-empty dir fails) — only then materialize the write root inside it.
  await syncSkillRepo(config);
  // Clone/sync owned read-only source repos (D-SK8) so their skills are available too.
  await syncSourceRepos(config);

  const paths = skillsPaths(config.runtimeDir);
  mkdirSync(paths.root, { recursive: true });

  let changed = 0;
  for (const seed of SEED_SKILLS) {
    const file = paths.skillFile(seed.name);
    if (!existsSync(file)) {
      mkdirSync(paths.skillDir(seed.name), { recursive: true });
      writeFileSync(file, seed.content, { mode: 0o644 });
      changed += 1;
    }
    // Install any bundled files (e.g. a skill's own scripts/) write-if-missing, so
    // the capability travels with the skill and self-heals if removed (D-SK1/D-SK4).
    for (const asset of seed.assets ?? []) {
      const dest = join(paths.skillDir(seed.name), asset.dest);
      if (existsSync(dest)) continue;
      try {
        const content = readFileSync(seedAssetPath(asset.src), 'utf8');
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content, { mode: asset.mode ?? 0o644 });
        changed += 1;
      } catch (err) {
        log.warn('could not install seed asset (non-fatal)', {
          skill: seed.name,
          asset: asset.dest,
          err: String(err),
        });
      }
    }
  }
  if (changed > 0) {
    log.info('seeded bundled skills', { count: changed });
    await commitSkillChange(config, 'skill: seed bundled skills');
  }
}

/** Resolve a bundled seed asset (`src/skills/seed-assets/<src>`) to an absolute path. */
function seedAssetPath(src: string): string {
  return fileURLToPath(new URL(`./seed-assets/${src}`, import.meta.url));
}

/** Commit a skill change, and push it to the canonical repo when one is configured
 *  (D-SK8, runtime-home). All git ops run in the authored CLONE root
 *  (`~/.sunny/skills/authored`) — the skill files live one level down under `skills/`,
 *  but the repo (and its `.git`) is the clone root. Only the authored tier is
 *  committed; `trusted/` (read-only clones) and `installed/` (third-party) are not.
 *  Best-effort and non-fatal: with no clone there's nowhere to commit (skill stays on
 *  disk); offline → committed locally and pushed on the next change/sync. */
async function commitSkillChange(config: SunnyConfig, message: string): Promise<void> {
  const root = authoredRoot(config.runtimeDir);
  if (!existsSync(join(root, '.git'))) {
    log.warn('authored skills root is not a git clone — skill change left uncommitted', { root });
    return;
  }
  try {
    await exec('git', ['add', '-A'], { cwd: root });
    await exec('git', ['commit', '-q', '-m', message], { cwd: root });
  } catch (err) {
    log.warn('could not commit skill change (non-fatal)', { err: String(err) });
    return;
  }
  if (config.skills.repo) {
    try {
      await exec('git', ['push', '--quiet'], { cwd: root });
    } catch (err) {
      log.warn('could not push skill change (committed locally)', { err: String(err) });
    }
  }
}
