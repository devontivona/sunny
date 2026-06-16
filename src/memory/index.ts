import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SunnyConfig } from '../config/index.js';
import { logger } from '../logger.js';

const log = logger('memory');
const exec = promisify(execFile);

/** Core file ids the write tool may target by name (plus `topics/<name>`). */
export type CoreFile = 'USER' | 'SUNNY' | 'INDEX';

export interface MemoryPaths {
  root: string;
  topicsDir: string;
  USER: string;
  SUNNY: string;
  INDEX: string;
  topic: (name: string) => string;
}

export function memoryPaths(runtimeDir: string): MemoryPaths {
  const root = join(runtimeDir, 'memory');
  return {
    root,
    topicsDir: join(root, 'topics'),
    USER: join(root, 'USER.md'),
    SUNNY: join(root, 'SUNNY.md'),
    INDEX: join(root, 'INDEX.md'),
    topic: (name: string) => join(root, 'topics', `${sanitizeTopic(name)}.md`),
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

/**
 * Cold-start seeding (R11) + the single `~/.sunny` git repo (D-PS2, D6).
 * Creates memory/ and skills/ dirs, seeds starter core files if absent, and
 * git-inits `~/.sunny` so memory has history/backup.
 */
export async function initMemory(config: SunnyConfig): Promise<void> {
  const paths = memoryPaths(config.runtimeDir);
  mkdirSync(paths.topicsDir, { recursive: true });
  mkdirSync(join(config.runtimeDir, 'skills'), { recursive: true });

  seedIfAbsent(paths.USER, starterUser(config.owner.name));
  seedIfAbsent(paths.SUNNY, starterSunny());
  seedIfAbsent(paths.INDEX, starterIndex());

  await ensureGitRepo(config.runtimeDir);
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
  return serialize(() => {
    const paths = memoryPaths(config.runtimeDir);
    const { filePath, cap, label } = resolveTarget(paths, config, input.file);

    const current = readIfExists(filePath);
    const next = computeNext(current, input);

    if (cap !== null && next.length > cap) {
      throw new MemoryOverflowError(label, next.length, cap);
    }

    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, next, { mode: 0o644 });
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

async function ensureGitRepo(dir: string): Promise<void> {
  if (existsSync(join(dir, '.git'))) return;
  try {
    await exec('git', ['init', '-q'], { cwd: dir });
    await exec('git', ['add', '-A'], { cwd: dir });
    await exec('git', ['commit', '-q', '-m', 'seed ~/.sunny memory'], { cwd: dir });
    log.info('initialized ~/.sunny git repo');
  } catch (err) {
    log.warn('could not init ~/.sunny git repo (non-fatal)', { err: String(err) });
  }
}

function starterUser(owner: string): string {
  return `# USER — model of ${owner}

_Durable facts about ${owner}: identity, preferences, people, comms style. Sunny keeps this current; ${owner} can hand-edit it._

- Name: ${owner}
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
