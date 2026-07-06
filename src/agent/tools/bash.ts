import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { tool } from 'ai';
import type { SunnyConfig } from '../../config/index.js';
import { resolveByName, type CredentialResolver } from '../../credentials/index.js';
import { BASH_TOOL_SPECS } from './bashSpecs.js';
import { FILE_TOOL_SPECS } from './fileSpecs.js';

const pexec = promisify(exec);

const MAX_OUTPUT_CHARS = 30_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_FILE_BYTES = 100_000;

// Sunny's own secrets are NEVER ambiently available to a command (a hijacked
// command could otherwise `echo $OP_SERVICE_ACCOUNT_TOKEN`). Per-command
// credentials are injected explicitly and masked out of the output instead.
const STRIPPED_ENV = [
  'OP_SERVICE_ACCOUNT_TOKEN',
  'ANTHROPIC_API_KEY',
  'SENDBLUE_API_KEY',
  'SENDBLUE_API_SECRET',
  'SENDBLUE_WEBHOOK_SECRET',
  'DASHBOARD_SESSION_SECRET',
  'DATABASE_URL',
];

function clip(s: string, max = MAX_OUTPUT_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

function formatResult(stdout: string, stderr: string, exit: number | string): string {
  const parts = [`exit: ${exit}`];
  if (stdout.trim()) parts.push(`stdout:\n${clip(stdout)}`);
  if (stderr.trim()) parts.push(`stderr:\n${clip(stderr)}`);
  if (!stdout.trim() && !stderr.trim()) parts.push('(no output)');
  return parts.join('\n');
}

interface RunOpts {
  /** Extra env vars merged into the (sanitized) subprocess environment. */
  env?: Record<string, string>;
  /** Secret values to mask out of stdout/stderr before returning. */
  mask?: string[];
}

/** Run a shell command on the host (real access — no sandbox). Sunny's own secrets
 *  are stripped from the env; any injected credential values are masked from the
 *  output. Never throws — non-zero exit, timeout, and oversized output are reported. */
export async function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  opts: RunOpts = {},
): Promise<string> {
  const masks = (opts.mask ?? []).filter(Boolean);
  const redact = (s: string) => masks.reduce((acc, sec) => acc.split(sec).join('«redacted»'), s);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIPPED_ENV) delete env[k];
  if (opts.env) Object.assign(env, opts.env);

  try {
    const { stdout, stderr } = await pexec(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      shell: '/bin/bash',
      env,
    });
    return formatResult(redact(stdout), redact(stderr), 0);
  } catch (err) {
    const e = err as {
      code?: number | string;
      signal?: string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const stdout = redact(e.stdout ?? '');
    const stderr = redact(e.stderr ?? '');
    if (e.killed || e.signal === 'SIGTERM') {
      return `Command timed out after ${timeoutMs}ms (killed).\n${formatResult(stdout, stderr, 'timeout')}`;
    }
    if (typeof e.message === 'string' && e.message.includes('maxBuffer')) {
      return `Command output exceeded ${MAX_BUFFER_BYTES} bytes and was aborted — narrow it (e.g. head/grep/tail).`;
    }
    return formatResult(stdout, stderr, typeof e.code === 'number' ? e.code : 1);
  }
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** Load a text file for the file tools: expand `~`, refuse directories and binary (NUL)
 *  content. Returns the decoded text or an `ERROR: …` string (never throws). The binary
 *  guard matters beyond usability: NUL/invalid code points poison the durable turn's
 *  Postgres write — real documents (PDF/image) should ride in as an ATTACHMENT (natively
 *  ingested), not be read as text. */
function loadTextFile(path: string): { text: string } | { error: string } {
  try {
    const full = expandHome(path);
    if (statSync(full).isDirectory())
      return { error: `ERROR: "${path}" is a directory, not a file` };
    const buf = readFileSync(full);
    if (buf.includes(0)) {
      return {
        error:
          `ERROR: "${path}" looks like a binary file (${buf.length} bytes), not text — not read. ` +
          `If it's a PDF/image the user sent, it's already available as an attachment; refer to that ` +
          `instead of reading the raw file.`,
      };
    }
    return { text: buf.toString('utf8') };
  } catch (err) {
    return { error: `ERROR: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface FileReadOpts {
  /** 1-based first line of the window (default 1). */
  offset?: number;
  /** Max lines returned (default 2000). */
  limit?: number;
  /** Backstop cap on returned bytes (default 100000). */
  maxBytes?: number;
}

const DEFAULT_READ_LIMIT = 2_000;
const MAX_LINE_CHARS = 2_000;

/**
 * Read a UTF-8 text file as a line-numbered window (cat -n style: number, tab, line) —
 * coding-agent-upgrade. `offset`/`limit` page through large files; `maxBytes` stays as a
 * backstop on the returned size. A truncated read ends with a note naming the offset to
 * continue from, so the model can keep paging. Returns the window or an `ERROR: …` string.
 */
export function readFileSafe(path: string, opts: FileReadOpts = {}): string {
  const loaded = loadTextFile(path);
  if ('error' in loaded) return loaded.error;

  const lines = loaded.text.split('\n');
  // A trailing newline yields a phantom empty last element — drop it so counts are honest.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  const offset = opts.offset ?? 1;
  const limit = opts.limit ?? DEFAULT_READ_LIMIT;
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  if (offset > lines.length) {
    return `ERROR: offset ${offset} is past the end of "${path}" (${lines.length} lines)`;
  }

  const out: string[] = [];
  let bytes = 0;
  let lastLine = offset - 1; // last line number actually emitted
  for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
    const raw = lines[i] ?? '';
    const clipped =
      raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…[line truncated]` : raw;
    const numbered = `${String(i + 1).padStart(6)}\t${clipped}`;
    bytes += numbered.length + 1;
    if (bytes > maxBytes && out.length > 0) break; // keep at least one line
    out.push(numbered);
    lastLine = i + 1;
  }

  if (lastLine < lines.length) {
    out.push(
      `…[showing lines ${offset}–${lastLine} of ${lines.length}; continue with offset: ${lastLine + 1}]`,
    );
  }
  return out.join('\n');
}

/**
 * Create or fully overwrite a UTF-8 text file (missing parent directories are created) —
 * coding-agent-upgrade. Returns a short confirmation or an `ERROR: …` string.
 */
export function writeFileSafe(path: string, content: string): string {
  try {
    const full = expandHome(path);
    const existed = existsSync(full);
    if (existed && statSync(full).isDirectory()) {
      return `ERROR: "${path}" is a directory, not a file`;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    const lineCount = content === '' ? 0 : content.split('\n').length;
    return `${existed ? 'Overwrote' : 'Wrote'} "${path}" (${Buffer.byteLength(content, 'utf8')} bytes, ${lineCount} lines).`;
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Exact-string file edit (coding-agent-upgrade D2): `oldString` must match the file
 * verbatim, exactly once unless `replaceAll`. Refusals are strings the model can recover
 * from (re-read the window, widen the anchor); the file is untouched on refusal. Returns
 * a confirmation naming the edited line, or an `ERROR: …` string.
 */
export function editFileSafe(
  path: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (oldString === '') return 'ERROR: old_string is empty — provide the exact text to replace.';
  if (oldString === newString) {
    return 'ERROR: old_string and new_string are identical — nothing to change.';
  }
  const loaded = loadTextFile(path);
  if ('error' in loaded) return loaded.error;
  const { text } = loaded;

  const count = text.split(oldString).length - 1;
  if (count === 0) {
    const preview = oldString.length > 120 ? `${oldString.slice(0, 120)}…` : oldString;
    return (
      `ERROR: old_string not found in "${path}". Nothing was changed. Re-read the file and ` +
      `copy the exact text — whitespace matters, and file_read line-number prefixes must be ` +
      `stripped. Looked for: ${JSON.stringify(preview)}`
    );
  }
  if (count > 1 && !replaceAll) {
    return (
      `ERROR: old_string matches ${count} places in "${path}". Nothing was changed. Widen ` +
      `old_string with surrounding lines until it is unique, or pass replace_all to replace ` +
      `every occurrence.`
    );
  }

  try {
    const edited = text.split(oldString).join(newString);
    writeFileSync(expandHome(path), edited, 'utf8');
    const line = text.slice(0, text.indexOf(oldString)).split('\n').length;
    return count === 1
      ? `Edited "${path}": replaced 1 occurrence at line ${line}.`
      : `Edited "${path}": replaced ${count} occurrences (first at line ${line}).`;
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export interface BashInput {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  /** Map of ENV_VAR → credential name (from the registry). */
  credentials?: Record<string, string>;
}

/** Resolve any requested credentials into the command's environment (op-run-style
 *  per-command injection, D-TA5), run it, and mask the injected values out of the
 *  output — the model never sees a value. */
export async function execBash(
  config: SunnyConfig,
  resolver: CredentialResolver | undefined,
  input: BashInput,
): Promise<string> {
  const cwd = input.cwd ? expandHome(input.cwd) : config.runtimeDir;
  const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const requested = Object.entries(input.credentials ?? {});
  if (requested.length === 0) return runBash(input.command, cwd, timeout);

  if (!resolver) {
    return 'ERROR: this command requested credentials, but no 1Password token is configured.';
  }
  const env: Record<string, string> = {};
  const mask: string[] = [];
  for (const [varName, credName] of requested) {
    try {
      const value = await resolveByName(resolver, config.runtimeDir, credName);
      env[varName] = value;
      mask.push(value);
    } catch (err) {
      return `ERROR resolving credential "${credName}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return runBash(input.command, cwd, timeout, { env, mask });
}

/**
 * Thin host tools (tool-access D-TA2): the universal `bash` capability surface plus the
 * file primitives `file_read` / `file_write` / `file_edit` (coding-agent-upgrade). **Real
 * host access, no sandbox** — command permissioning, taint-tracking, and the hard
 * blocklist arrive with the security-permissions change; until then this is
 * attended-testing-only. Owner DMs only; autonomous/scheduled runs use a separate
 * memory-only toolset and never receive these. Per-command credential injection (D-TA5)
 * lets a command use a vault secret without the value reaching the model.
 */
export function createBashTools(config: SunnyConfig, resolver?: CredentialResolver) {
  return {
    bash: tool({
      ...BASH_TOOL_SPECS.bash,
      execute: ({ command, cwd, timeout_ms, credentials }) =>
        execBash(config, resolver, {
          command,
          cwd,
          timeout_ms,
          credentials: credentials
            ? Object.fromEntries(Object.entries(credentials).map(([k, v]) => [k, String(v)]))
            : undefined,
        }),
    }),
    file_read: tool({
      ...BASH_TOOL_SPECS.file_read,
      execute: ({ path, offset, limit, max_bytes }) =>
        Promise.resolve(readFileSafe(path, { offset, limit, maxBytes: max_bytes })),
    }),
    file_write: tool({
      ...FILE_TOOL_SPECS.file_write,
      execute: ({ path, content }) => Promise.resolve(writeFileSafe(path, content)),
    }),
    file_edit: tool({
      ...FILE_TOOL_SPECS.file_edit,
      execute: ({ path, old_string, new_string, replace_all }) =>
        Promise.resolve(editFileSafe(path, old_string, new_string, replace_all ?? false)),
    }),
  };
}
