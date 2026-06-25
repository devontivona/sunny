import { exec } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tool } from 'ai';
import type { SunnyConfig } from '../../config/index.js';
import { resolveByName, type CredentialResolver } from '../../credentials/index.js';
import { BASH_TOOL_SPECS } from './bashSpecs.js';

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

/** Read a UTF-8 text file (capped). Returns the contents or an `ERROR: …` string. */
export function readFileSafe(path: string, maxBytes = MAX_FILE_BYTES): string {
  try {
    const full = expandHome(path);
    if (statSync(full).isDirectory()) return `ERROR: "${path}" is a directory, not a file`;
    const buf = readFileSync(full);
    const text = buf.subarray(0, maxBytes).toString('utf8');
    return buf.length > maxBytes
      ? `${text}\n…[truncated ${buf.length - maxBytes} of ${buf.length} bytes]`
      : text;
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
 * Thin host tools (tool-access D-TA2): the universal `bash` capability surface plus
 * a `file_read` companion. **Real host access, no sandbox** — command permissioning,
 * taint-tracking, and the hard blocklist arrive with the security-permissions change;
 * until then this is attended-testing-only. Owner DMs only; autonomous/scheduled runs
 * use a separate memory-only toolset and never receive these. Per-command credential
 * injection (D-TA5) lets a command use a vault secret without the value reaching the model.
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
      execute: ({ path, max_bytes }) =>
        Promise.resolve(readFileSafe(path, max_bytes ?? MAX_FILE_BYTES)),
    }),
  };
}
