import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, type SunnyConfig } from '../config/index.js';
import { commitState, initStateRepo } from '../state/index.js';

/** Core file ids the write tool may target by name (plus `topics/<name>`). */
export type CoreFile = 'USER' | 'SUNNY' | 'INDEX';

export interface MemoryPaths {
  root: string;
  topicsDir: string;
  peopleDir: string;
  USER: string;
  SUNNY: string;
  INDEX: string;
  topic: (name: string) => string;
  person: (id: string) => string;
}

export function memoryPaths(runtimeDir: string): MemoryPaths {
  // Memory lives in the `state` repo (runtime-home): `~/.sunny/state/memory/`.
  const root = join(stateDir(runtimeDir), 'memory');
  return {
    root,
    topicsDir: join(root, 'topics'),
    peopleDir: join(root, 'people'),
    USER: join(root, 'USER.md'),
    SUNNY: join(root, 'SUNNY.md'),
    INDEX: join(root, 'INDEX.md'),
    topic: (name: string) => join(root, 'topics', `${sanitizeTopic(name)}.md`),
    person: (id: string) => join(root, 'people', `${sanitizePersonId(id)}.md`),
  };
}

/** Restrict topic names to a safe slug — prevents path traversal. */
export function sanitizeTopic(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`invalid topic name: ${name}`);
  return slug;
}

/**
 * Stable, filesystem-safe id for a per-person profile doc (multiplayer-family D3), derived from a
 * normalized identity (the same key the authorizer matches on). Phones/emails reduce to a slug,
 * e.g. `+1 (719) 314-6820` → `17193146820`, `kate@x.com` → `kate-x-com`.
 */
export function personId(identity: string): string {
  // Mirror the authorizer's identity normalization so formatting variants of one phone/email map
  // to the SAME doc: phones reduce to digits, emails lowercase. Then slug to a filesystem-safe id.
  const t = identity.trim().toLowerCase();
  const base = /[0-9]/.test(t) && !t.includes('@') ? t.replace(/[^0-9]/g, '') : t;
  const slug = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`invalid person identity: ${identity}`);
  return slug;
}

/** Defensively re-slug a person id used as a write target (prevents path traversal). */
export function sanitizePersonId(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`invalid person id: ${id}`);
  return slug;
}

/** The always-on core, loaded fresh each run (agent-memory D3). */
export interface MemoryCore {
  user: string;
  sunny: string;
  index: string;
}

export function loadCore(paths: MemoryPaths): MemoryCore {
  return {
    user: readIfExists(paths.USER),
    sunny: readIfExists(paths.SUNNY),
    index: readIfExists(paths.INDEX),
  };
}

export function readTopic(paths: MemoryPaths, name: string): string | null {
  const file = paths.topic(name);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** A person present in the current thread, for per-person doc loading (multiplayer-family D3). */
export interface PersonRef {
  id: string;
  name: string;
  identity: string;
}

/** A loaded per-person profile doc, ready to inject into the prompt. */
export interface PersonDoc {
  id: string;
  name: string;
  content: string;
}

/**
 * Ensure each family participant has a profile doc (auto-create on first contact, D3), then load
 * them for injection. Seeds + commits a starter doc when absent. Used by the durable turn's
 * setup step (real Node), so fs/git side effects are fine here.
 */
export async function ensureAndLoadPeople(
  config: SunnyConfig,
  people: PersonRef[],
): Promise<PersonDoc[]> {
  if (people.length === 0) return [];
  const paths = memoryPaths(config.runtimeDir);
  mkdirSync(paths.peopleDir, { recursive: true });
  let created = false;
  const docs: PersonDoc[] = [];
  for (const p of people) {
    const file = paths.person(p.id);
    if (!existsSync(file)) {
      writeFileSync(file, starterPerson(p.name, p.identity), { mode: 0o644 });
      created = true;
    }
    docs.push({ id: p.id, name: p.name, content: readIfExists(file) });
  }
  if (created) await commitState(config.runtimeDir, 'memory: seed person doc(s)');
  return docs;
}

/**
 * Cold-start seeding (R11) + the `state` git repo (runtime-home). Initialize (or
 * clone) `~/.sunny/state/` FIRST so a fresh host with a configured private remote
 * gets its existing memory back before we seed; then seed starter core files if
 * absent and commit them. Memory now lives under `state/memory/`; skills/ and media/
 * are independent siblings initialized elsewhere.
 */
export async function initMemory(config: SunnyConfig): Promise<void> {
  await initStateRepo(config);

  const paths = memoryPaths(config.runtimeDir);
  mkdirSync(paths.topicsDir, { recursive: true });
  mkdirSync(paths.peopleDir, { recursive: true });

  seedIfAbsent(paths.USER, starterUser(config.owner.name));
  seedIfAbsent(paths.SUNNY, starterSunny());
  seedIfAbsent(paths.INDEX, starterIndex());

  await commitState(config.runtimeDir, 'memory: seed core');
}

// --- Serialized writer (agent-memory R7 / D-MG / task 3.8) -----------------
// All memory-file mutations funnel through one promise chain so concurrent
// turns / jobs cannot corrupt the markdown. Reads snapshot at run start.
let writeChain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  // Keep the chain alive regardless of individual outcomes.
  writeChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export type WriteAction = 'add' | 'replace' | 'remove';

export interface MemoryWriteInput {
  /** 'USER' | 'SUNNY' | 'INDEX', or 'topic:<name>' for a topic doc. */
  file: string;
  action: WriteAction;
  /** Text to add, the full replacement body, or (with target) the new text. */
  content?: string;
  /** For replace/remove: the existing substring to replace or remove. */
  target?: string;
}

export class MemoryOverflowError extends Error {
  constructor(
    public readonly file: string,
    public readonly size: number,
    public readonly cap: number,
  ) {
    super(
      `memory file ${file} would be ${size} chars, over its ${cap} cap. ` +
        `Consolidate it (merge, prune, or promote detail to a topic doc) and retry.`,
    );
    this.name = 'MemoryOverflowError';
  }
}

/**
 * Apply a memory write (add/replace/remove). No `read` action — the core is
 * already in context (D2). Capped core files error on overflow to force
 * consolidation; topic docs are unbounded.
 */
export function applyMemoryWrite(config: SunnyConfig, input: MemoryWriteInput): Promise<string> {
  return serialize(async () => {
    const paths = memoryPaths(config.runtimeDir);
    const { filePath, cap, label } = resolveTarget(paths, config, input.file);

    const current = readIfExists(filePath);
    const next = computeNext(current, input);

    if (cap !== null && next.length > cap) {
      throw new MemoryOverflowError(label, next.length, cap);
    }

    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, next, { mode: 0o644 });
    // Capture the edit in the `state` repo's history (runtime-home). Best-effort:
    // never fails the write, even with no repo (committed on the periodic push).
    await commitState(config.runtimeDir, `memory: ${input.action} ${label}`);
    return `ok: ${input.action} on ${label} (${next.length} chars)`;
  });
}

function computeNext(current: string, input: MemoryWriteInput): string {
  switch (input.action) {
    case 'add': {
      const add = (input.content ?? '').trim();
      if (!add) throw new Error('add requires content');
      const sep = current === '' || current.endsWith('\n') ? '' : '\n';
      return `${current}${sep}${add}\n`;
    }
    case 'replace': {
      if (input.target) {
        if (!current.includes(input.target)) {
          throw new Error('replace target not found in file');
        }
        return current.replace(input.target, input.content ?? '');
      }
      // No target → full-file replace (the consolidation primitive).
      return `${(input.content ?? '').trimEnd()}\n`;
    }
    case 'remove': {
      const target = input.target ?? input.content;
      if (!target) throw new Error('remove requires target or content');
      if (!current.includes(target)) throw new Error('remove target not found in file');
      return current.replace(target, '');
    }
  }
}

function resolveTarget(
  paths: MemoryPaths,
  config: SunnyConfig,
  file: string,
): { filePath: string; cap: number | null; label: string } {
  if (file.startsWith('topic:')) {
    const name = file.slice('topic:'.length);
    return { filePath: paths.topic(name), cap: null, label: `topics/${sanitizeTopic(name)}.md` };
  }
  if (file.startsWith('people:')) {
    // Per-person profile doc (multiplayer-family D3). Capped like USER so a person's model stays
    // a concise core (deeper detail goes to topic docs); unbounded would defeat the core/topic split.
    const id = file.slice('people:'.length);
    return {
      filePath: paths.person(id),
      cap: config.memory.userMaxChars,
      label: `people/${sanitizePersonId(id)}.md`,
    };
  }
  switch (file.toUpperCase()) {
    case 'USER':
      return { filePath: paths.USER, cap: config.memory.userMaxChars, label: 'USER.md' };
    case 'SUNNY':
      return { filePath: paths.SUNNY, cap: config.memory.sunnyMaxChars, label: 'SUNNY.md' };
    case 'INDEX':
      return { filePath: paths.INDEX, cap: config.memory.indexMaxChars, label: 'INDEX.md' };
    default:
      throw new Error(`unknown memory file '${file}' (use USER, SUNNY, INDEX, or topic:<name>)`);
  }
}

// --- helpers ---------------------------------------------------------------

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function seedIfAbsent(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, content, { mode: 0o644 });
}

function starterUser(owner: string): string {
  return `# USER — model of ${owner}

_Durable facts about ${owner}: identity, preferences, people, comms style. Sunny keeps this current; ${owner} can hand-edit it._

- Name: ${owner}
`;
}

function starterPerson(name: string, identity: string): string {
  return `# ${name} — profile

_Durable facts about ${name} (a family member who messages Sunny): identity, preferences, people, comms style. Sunny keeps this current. Use discretion about sharing one person's facts with another._

- Name: ${name}
- Identity: ${identity}
`;
}

function starterSunny(): string {
  return `# SUNNY — operating notes

_How Sunny should behave: learned conventions, preferences about its own conduct. Sunny writes this; distinct from facts about the user._

- Be concise and warm over iMessage. Think privately; say only what's worth saying.
`;
}

function starterIndex(): string {
  return `# INDEX — topic router

_One line per topic doc under topics/. Sunny reads a topic only when relevant._
`;
}
