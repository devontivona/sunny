import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { tool } from 'ai';
import { runtimeDir, stateDir, type SunnyConfig } from '../../config/index.js';
import { resolveByName, type CredentialResolver } from '../../credentials/index.js';
import { SECRET_ENV_KEYS } from '../../observability/redact.js';
import { BASH_TOOL_SPECS } from './bashSpecs.js';
import { FILE_TOOL_SPECS } from './fileSpecs.js';

const MAX_OUTPUT_CHARS = 30_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_FILE_BYTES = 100_000;
// After the timeout SIGTERMs the process group, how long to wait before SIGKILL +
// hard-resolving the call regardless of whether the stdio pipes ever close (a
// backgrounded grandchild can hold them open forever).
const KILL_GRACE_MS = 250;

// Bash-specific keys to strip beyond the shared secret set (none today, but kept
// as an explicit seam for shell-only sensitive vars).
const BASH_ONLY_STRIPPED_ENV: readonly string[] = [];

// Sunny's own secrets are NEVER ambiently available to a command (a hijacked
// command could otherwise `echo $OP_SERVICE_ACCOUNT_TOKEN`). Per-command
// credentials are injected explicitly and masked out of the output instead.
// Derived from redact.ts SECRET_ENV_KEYS (the single source of truth) so a newly
// classified secret can't be scrubbed at telemetry sinks yet still leak here.
const STRIPPED_ENV = [...new Set<string>([...SECRET_ENV_KEYS, ...BASH_ONLY_STRIPPED_ENV])];

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

interface ShellResult {
  stdout: string;
  stderr: string;
  /** Numeric exit code (present on a normal exit). */
  code?: number | null;
  /** Killed by our timeout (group SIGTERM/SIGKILL). */
  timedOut?: boolean;
  /** Output exceeded MAX_BUFFER_BYTES and the command was aborted. */
  overflow?: boolean;
  /** Spawn/exec failure (e.g. cwd doesn't exist). */
  error?: Error;
}

/**
 * Run `/bin/bash -c command` in its OWN process group (detached) so that on
 * timeout we can kill the *whole* group with `process.kill(-pid, …)` — not just
 * the shell. A backgrounded grandchild (`server & sleep 2`) inherits the stdout
 * pipe and would otherwise keep it open forever, so a close-driven wait never
 * settles; a hard deadline resolves the call regardless of pipe state.
 */
function spawnShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      env,
      detached: true, // new process group; pgid === child.pid
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal); // negative pid → whole process group
      } catch {
        // group already gone
      }
    };

    const settle = (result: ShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      // Hard deadline: if the group's pipes stay open (orphaned grandchild),
      // SIGKILL the group and resolve anyway so the tool never hangs.
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
        settle({ stdout, stderr, timedOut: true });
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);

    const onChunk = (buf: Buffer, sink: 'out' | 'err') => {
      bytes += buf.length;
      if (bytes > MAX_BUFFER_BYTES) {
        overflow = true;
        killGroup('SIGKILL');
        settle({ stdout, stderr, overflow: true });
        return;
      }
      if (sink === 'out') stdout += buf.toString('utf8');
      else stderr += buf.toString('utf8');
    };

    child.stdout?.on('data', (b: Buffer) => onChunk(b, 'out'));
    child.stderr?.on('data', (b: Buffer) => onChunk(b, 'err'));
    child.on('error', (error) => settle({ stdout, stderr, error }));
    child.on('close', (code) => settle({ stdout, stderr, code, timedOut }));
  });
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
  // The sunny repo root, for builtin content that must stay machine-agnostic
  // (portability D10): builtin skills say `cd "$SUNNY_REPO"` instead of baking in a path.
  env.SUNNY_REPO = process.cwd();
  if (opts.env) Object.assign(env, opts.env);

  const r = await spawnShell(command, cwd, timeoutMs, env);
  const stdout = redact(r.stdout);
  const stderr = redact(r.stderr);

  if (r.overflow) {
    return `Command output exceeded ${MAX_BUFFER_BYTES} bytes and was aborted — narrow it (e.g. head/grep/tail).`;
  }
  if (r.timedOut) {
    return `Command timed out after ${timeoutMs}ms (killed).\n${formatResult(stdout, stderr, 'timeout')}`;
  }
  if (r.error) {
    return formatResult(stdout, redact(r.error.message), 1);
  }
  return formatResult(stdout, stderr, typeof r.code === 'number' ? r.code : 1);
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  // `$SUNNY_REPO` = the sunny repo root (process.cwd(), the drizzle/ contract). Builtin
  // skills/schedules under `agent/` are addressed this way so no builtin content or
  // prompt text ever embeds a machine-specific absolute path (portability D10).
  if (p === '$SUNNY_REPO') return process.cwd();
  if (p.startsWith('$SUNNY_REPO/')) return join(process.cwd(), p.slice('$SUNNY_REPO/'.length));
  return p;
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
          `If it's an image, open it with view_image to actually see it. If it's a PDF/image the ` +
          `user sent, it's already available as an attachment; refer to that.`,
      };
    }
    return { text: buf.toString('utf8') };
  } catch (err) {
    return { error: `ERROR: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Write-authority guard (runtime-home-data-split): `~/.sunny/state/` is the CODE-MANAGED
 * record — the agent's mutation tools refuse it, which is what keeps the state repo's
 * commit-on-write history truthful. Reads stay unrestricted. Resolution is symlink- and
 * `..`-safe: the target is resolved lexically, then the real path of its deepest EXISTING
 * ancestor is swapped in, so neither a symlink into `state/` nor a `../` path can smuggle
 * a write past the check. Returns the refusal message, or null when the path is fine.
 */
function refuseStateWrite(path: string): string | null {
  const state = stateDir(runtimeDir());
  const stateReal = existsSync(state) ? realpathSync(state) : resolve(state);
  let full = resolve(expandHome(path));
  let ancestor = full;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (existsSync(ancestor)) {
    full = join(realpathSync(ancestor), full.slice(ancestor.length));
  }
  if (full !== stateReal && !full.startsWith(stateReal + sep)) return null;
  return (
    `ERROR: "${path}" is inside ~/.sunny/state — Sunny's code-managed record, written only ` +
    `by the runtime itself. Nothing was changed. Durable files you author go in ` +
    `~/.sunny/data/ (sites → data/sites/, projects → data/projects/); temporary working ` +
    `files go in ~/.sunny/scratch/.`
  );
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
    const refused = refuseStateWrite(path);
    if (refused) return refused;
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
  try {
    const refused = refuseStateWrite(path);
    if (refused) return refused;
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
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
