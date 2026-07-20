/**
 * Redaction-at-source (observability D-OB5; change `observability` task 2).
 *
 * A hard property of every telemetry sink: secret values and the 1Password
 * Service Account token must never appear in spans, Langfuse traces, logs, or
 * any record bound for a sink. This is the single filter all sinks reuse — the
 * gate that must be in place before any real data is exported (task 3), so
 * secrets never reach Langfuse/Clickhouse.
 *
 * The redactor is built from concrete secret values (so it scrubs the exact
 * strings that are dangerous) plus a few defensive patterns (so a freshly
 * minted key is caught even before it is wired into config). It is injected at
 * a seam — `createRedactor({ secrets, patterns })` is pure and unit-tested with
 * injected secrets; `defaultRedactor()` is the production binding that reads the
 * known secret env vars.
 */

const PLACEHOLDER = '[REDACTED]';

/**
 * Env vars whose *values* are secret (or sensitive enough to keep out of
 * telemetry). Kept in sync with `.env.example` / README "Secrets". `op://`
 * references are NOT secret (they are pointers), so we never scrub those — only
 * the Service Account token that resolves them.
 */
export const SECRET_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'SENDBLUE_API_KEY',
  'SENDBLUE_API_SECRET',
  'SENDBLUE_WEBHOOK_SECRET',
  'OP_SERVICE_ACCOUNT_TOKEN',
  'DATABASE_URL',
  'WORKFLOW_POSTGRES_URL',
  'DASHBOARD_SESSION_SECRET',
  'LANGFUSE_SECRET_KEY',
] as const;

/** A defensive value pattern plus the replacement it rewrites matches to. */
export interface SecretPattern {
  re: RegExp;
  /** Replacement string; may reference capture groups (e.g. `$1`). */
  replace: string;
}

/**
 * Defensive value patterns — catch secret-shaped strings even if their exact
 * value was not registered (e.g. a key rotated since startup). Each must have a
 * low false-positive rate; we only redact things that look unmistakably like a
 * credential.
 */
export const DEFAULT_SECRET_PATTERNS: readonly SecretPattern[] = [
  // Anthropic API keys.
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/g, replace: PLACEHOLDER },
  // 1Password Service Account tokens.
  { re: /ops_eyJ[A-Za-z0-9_.-]{20,}/g, replace: PLACEHOLDER },
  // Postgres connection-string credentials: keep scheme/host/db, drop user:pass.
  { re: /(postgres(?:ql)?:\/\/)[^:/@\s]+:[^@\s]+@/gi, replace: `$1${PLACEHOLDER}@` },
  // HTTP Authorization bearer/basic tokens.
  { re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/g, replace: PLACEHOLDER },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RedactorOptions {
  /** Concrete secret values to scrub wherever they appear as a substring. */
  secrets?: readonly string[];
  /** Additional value patterns to scrub. Defaults to {@link DEFAULT_SECRET_PATTERNS}. */
  patterns?: readonly SecretPattern[];
  /**
   * Shortest secret value we will scrub literally. Guards against blanking the
   * output when an env var holds a trivially short / empty placeholder value.
   */
  minLength?: number;
}

export interface Redactor {
  /** Redact a single string, replacing every secret occurrence. */
  redactString(value: string): string;
  /**
   * Recursively redact a value of any shape (string/array/object), returning a
   * copy with secrets scrubbed. Keys are preserved; only string values and
   * stringified primitives are filtered. Non-plain values are returned as-is.
   */
  redact<T>(value: T): T;
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const minLength = options.minLength ?? 6;
  const patterns = options.patterns ?? DEFAULT_SECRET_PATTERNS;

  // Longest-first so an enclosing secret is scrubbed before any shorter secret
  // that happens to be a substring of it.
  const secrets = [...new Set(options.secrets ?? [])]
    .filter((s) => s.length >= minLength)
    .sort((a, b) => b.length - a.length);
  const literalRe = secrets.length ? new RegExp(secrets.map(escapeRegExp).join('|'), 'g') : null;

  function redactString(value: string): string {
    let out = value;
    if (literalRe) out = out.replace(literalRe, PLACEHOLDER);
    for (const { re, replace } of patterns) {
      // `.replace` with a global regex starts from index 0 regardless of
      // lastIndex, so shared patterns are safe to reuse across calls.
      out = out.replace(re, replace);
    }
    return out;
  }

  function redact<T>(value: T, seen = new WeakSet<object>()): T {
    if (typeof value === 'string') return redactString(value) as T;
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return value;
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((v) => redact(v, seen)) as T;
    }
    // Only walk plain objects; leave class instances (Error, Date, etc.) alone
    // beyond their string form so we don't mangle them.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // The credential save action's secret input (credential_manage "save") is a
      // freshly generated value no env-derived literal or shape pattern can know —
      // redact it by its exact key wherever it appears in a traced payload.
      out[k] = k === 'secretValue' && typeof v === 'string' ? PLACEHOLDER : redact(v, seen);
    }
    return out as T;
  }

  return { redactString, redact: (v) => redact(v) };
}

let cached: Redactor | undefined;

/** Collect the current secret env values (non-empty, deduped). */
function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const v = env[key];
    if (v && v.trim()) out.push(v.trim());
  }
  return out;
}

/**
 * Production redactor, memoized. Built from the secret env values present at
 * first use plus the defensive patterns. Call {@link resetDefaultRedactor} in
 * tests if the environment changes.
 */
export function defaultRedactor(): Redactor {
  if (!cached) cached = createRedactor({ secrets: secretsFromEnv() });
  return cached;
}

/** Test helper: drop the memoized default redactor. */
export function resetDefaultRedactor(): void {
  cached = undefined;
}
