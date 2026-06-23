#!/usr/bin/env node
// `skill` — Sunny's skill-authoring helper CLI (agent-skills D-SK4/7/8).
//
// Skill authoring is a *skill*, not a bespoke tool (D-SK4): the bundled
// `skill-authoring` seed tells Sunny to write a skill's files directly (a skill is
// a DIRECTORY — SKILL.md plus optional scripts/, references/, assets/) over the
// bash/file tools, then run this helper to persist them. This command owns the
// load-bearing, get-it-right-every-time steps so the model doesn't have to drive
// multi-step git by hand:
//
//   skill new <name> -d "trigger description"   scaffold a draft directory + SKILL.md
//   skill save <name>                           validate → stage → commit → push
//   skill rm   <name>                           remove the skill → commit → push
//
// This file is BUNDLED INTO the `skill-authoring` seed skill: `initSkills` installs
// it at ~/.sunny/skills/skill-authoring/scripts/skill.mjs, so it travels with the
// skill (into the canonical skill repo on push) and needs no global install — the
// skill body invokes it with `node`. Plain Node + git only (no build step, no tsx)
// so it runs on any host as-is. It is the deterministic counterpart of the in-process
// helpers in `src/skills/index.ts`; the small validation/slug logic below is
// intentionally duplicated to keep this dependency-free, and mirrors
// `sanitizeSkillName`/`validateSkill` there — keep them in sync.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- pure helpers (exported for unit tests; mirror src/skills/index.ts) -----

/** Restrict a skill name to a safe slug — prevents path traversal. */
export function sanitizeName(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`invalid skill name: ${name}`);
  return slug;
}

/** Parse a SKILL.md's leading `---` frontmatter into a flat scalar map. */
export function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const out = {};
  if (!m) return out;
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = (kv[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[kv[1].toLowerCase()] = value;
  }
  return out;
}

/** Validate a SKILL.md against the minimal required schema (D-SK7). */
export function validate(raw) {
  const errors = [];
  const fm = parseFrontmatter(raw);
  if (!fm.name) errors.push('missing frontmatter: name');
  else {
    try {
      sanitizeName(fm.name);
    } catch {
      errors.push(`invalid name: ${fm.name}`);
    }
  }
  if (!fm.description) errors.push('missing frontmatter: description');
  return { ok: errors.length === 0, errors };
}

/** Compose a starter SKILL.md (frontmatter + body) from fields. */
export function composeSkill({ name, description, body }) {
  const slug = sanitizeName(name);
  const desc = String(description).trim().replace(/\s*\n\s*/g, ' ');
  return `---\nname: ${slug}\ndescription: ${desc}\n---\n\n${String(body).trim()}\n`;
}

// --- environment ------------------------------------------------------------

/** Resolve the runtime dir the same way the app does (SUNNY_HOME → ~/.sunny). */
function runtimeDir() {
  return process.env.SUNNY_HOME ?? join(homedir(), '.sunny');
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function hasRemote(cwd) {
  try {
    return git(['remote'], cwd).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Stage + commit the skills tree, and push when the working copy is its own repo
 * (a clone of the canonical skill repo, D-SK8) with a remote configured. Mirrors
 * `commitSkillChange` in src/skills/index.ts. Returns what happened so the caller
 * can report it. Best-effort push: offline → committed locally.
 */
function gitPersist(dir, message) {
  const root = join(dir, 'skills');
  const ownRepo = existsSync(join(root, '.git'));
  const cwd = ownRepo ? root : dir;
  if (!ownRepo && !existsSync(join(dir, '.git'))) {
    return { committed: false, pushed: false, note: 'no git repo — saved to disk only' };
  }
  git(['add', '-A', ...(ownRepo ? [] : ['skills'])], cwd);
  try {
    git(['commit', '-q', '-m', message], cwd);
  } catch (err) {
    const blob = `${err?.stdout ?? ''}${err?.stderr ?? ''}${err?.message ?? ''}`;
    if (/nothing to commit/i.test(blob)) return { committed: false, pushed: false, note: 'nothing changed' };
    throw err;
  }
  let pushed = false;
  if (ownRepo && hasRemote(root)) {
    try {
      git(['push', '--quiet'], root);
      pushed = true;
    } catch {
      /* offline / rejected — committed locally, will sync on next push */
    }
  }
  return { committed: true, pushed, note: '' };
}

function persistSuffix(r) {
  if (r.pushed) return ' (committed + pushed)';
  if (r.committed) return ' (committed locally)';
  return ` (${r.note})`;
}

// --- commands ---------------------------------------------------------------

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
function done(msg) {
  process.stdout.write(`ok: ${msg}\n`);
}

function cmdNew(name, description) {
  const slug = sanitizeName(name);
  if (!description) fail('`new` requires a description: skill new <name> -d "what triggers it"');
  const dir = join(runtimeDir(), 'skills', slug);
  const file = join(dir, 'SKILL.md');
  if (existsSync(file)) fail(`skill "${slug}" already exists at ${dir}`);
  const raw = composeSkill({
    name: slug,
    description,
    body: 'TODO: write the procedure — what to do, step by step. Add scripts/, references/, or assets/ files alongside this one as needed.',
  });
  const v = validate(raw);
  if (!v.ok) fail(`invalid: ${v.errors.join('; ')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, raw, { mode: 0o644 });
  done(`scaffolded ${dir}\n  edit SKILL.md (and add any scripts/ references/ assets/), then: skill save ${slug}`);
}

function cmdSave(name) {
  const slug = sanitizeName(name);
  const file = join(runtimeDir(), 'skills', slug, 'SKILL.md');
  if (!existsSync(file)) fail(`no SKILL.md for "${slug}" — run: skill new ${slug} -d "..."`);
  const v = validate(readFileSync(file, 'utf8'));
  if (!v.ok) fail(`invalid SKILL.md: ${v.errors.join('; ')}`);
  const r = gitPersist(runtimeDir(), `skill: save ${slug}`);
  done(`saved "${slug}"${persistSuffix(r)}. Tell the owner you wrote it.`);
}

function cmdRm(name) {
  const slug = sanitizeName(name);
  const dir = join(runtimeDir(), 'skills', slug);
  if (!existsSync(dir)) fail(`no skill named "${slug}"`);
  rmSync(dir, { recursive: true, force: true });
  const r = gitPersist(runtimeDir(), `skill: delete ${slug}`);
  done(`deleted "${slug}"${persistSuffix(r)}.`);
}

function gitErrMsg(err) {
  return String(err?.stderr || err?.stdout || err?.message || err).trim().split('\n')[0];
}

/** Pull the latest skills from the canonical repo, fast-forward only. Mirrors
 *  `syncSkillRepo` in src/skills/index.ts — never auto-merges; reports divergence
 *  for the owner to reconcile. On-demand counterpart of the hourly background sync. */
function cmdSync() {
  const root = join(runtimeDir(), 'skills');
  if (!existsSync(join(root, '.git'))) fail('skills dir is not a git clone — nothing to sync');
  try {
    git(['fetch', '--quiet'], root);
  } catch (err) {
    fail(`fetch failed (offline?): ${gitErrMsg(err)}`);
  }
  let upstream;
  try {
    upstream = git(['rev-parse', '--abbrev-ref', '@{u}'], root).trim();
  } catch {
    fail('no upstream tracking branch configured for the skills clone');
  }
  const behind = Number(git(['rev-list', '--count', '@..@{u}'], root).trim());
  const ahead = Number(git(['rev-list', '--count', '@{u}..@'], root).trim());
  if (behind === 0) {
    done(ahead > 0 ? `up to date (${ahead} local commit(s) not yet pushed)` : 'up to date — no new skills');
    return;
  }
  if (ahead > 0) {
    fail(
      `diverged: ${ahead} local + ${behind} remote commit(s). Reconcile manually in ${root} ` +
        `(e.g. git pull --rebase), then save again — not auto-merging.`,
    );
  }
  git(['merge', '--ff-only', '--quiet', upstream], root);
  done(`pulled ${behind} update(s) from ${upstream}.`);
}

const USAGE = `skill — author Sunny's own skills (a skill is a directory: SKILL.md + optional scripts/ references/ assets/)

usage:
  skill new <name> -d "trigger description"   scaffold a draft skill directory
  skill save <name>                           validate, commit, and push the skill
  skill rm <name>                             delete the skill, commit, and push
  skill sync                                  pull the latest skills from the repo (fast-forward only)

write/edit the skill's files with your normal file tools, then 'skill save <name>'.`;

export function main(argv) {
  const [cmd, ...rest] = argv;
  // Pull -d/--description out of the positionals.
  let description;
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '-d' || rest[i] === '--description') description = rest[++i];
    else args.push(rest[i]);
  }
  switch (cmd) {
    case 'new':
      if (!args[0]) fail('`new` requires a name');
      return cmdNew(args[0], description);
    case 'save':
      if (!args[0]) fail('`save` requires a name');
      return cmdSave(args[0]);
    case 'rm':
    case 'delete':
      if (!args[0]) fail('`rm` requires a name');
      return cmdRm(args[0]);
    case 'sync':
      return cmdSync();
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(`${USAGE}\n`);
      return;
    default:
      fail(`unknown command "${cmd}" (try: skill help)`);
  }
}

// Run only when invoked as a script (not when imported by a test).
const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2));
