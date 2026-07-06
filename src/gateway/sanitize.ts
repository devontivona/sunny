/**
 * Postgres-safety sanitizer for persisted content (messaging hardening).
 *
 * Postgres `text` and `jsonb` cannot store the NUL code point (U+0000) or unpaired
 * UTF-16 surrogates: an INSERT carrying either fails deterministically with
 * "null character not permitted" / "unsupported Unicode escape sequence". External
 * content — file reads (e.g. a binary PDF read as text), bash output, inbound
 * message text, subagent/MCP/web results — can carry both, so every string reaching
 * a DB write passes through here first.
 *
 * This is the BROAD backstop: no single content source can poison a persist,
 * regardless of where the bytes came from. Source-level guards (binary file
 * detection, native media ingestion) stop generating the bad content in the first
 * place; this guarantees the write never fails even if one slips through.
 */

// NUL (U+0000) and unpaired UTF-16 surrogates are the code points Postgres rejects
// in text/jsonb. Escapes (not literal control chars) keep the source clean.
// eslint-disable-next-line no-control-regex
const NUL = /\u0000/g;
// A high surrogate NOT followed by a low one, or a low surrogate NOT preceded by a high one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Strip NUL and replace lone surrogates with U+FFFD so a string is safe for
 *  Postgres `text`/`jsonb`. A no-op for the overwhelmingly common clean string. */
export function sanitizePgText(s: string): string {
  return s.replace(NUL, '').replace(LONE_SURROGATE, '�');
}

/**
 * Deep-sanitize any JSON-serializable value for a `jsonb` column: walks strings in
 * nested objects/arrays and applies {@link sanitizePgText}. Numbers/booleans/null
 * pass through untouched. Returns a new value (does not mutate the input).
 */
export function sanitizePgJson<T>(value: T): T {
  if (typeof value === 'string') return sanitizePgText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizePgJson(v)) as unknown as T;
  if (value && typeof value === 'object') {
    // Respect `toJSON` first (Date, Buffer, …) so a class instance serializes the way the
    // JSONB writer (JSON.stringify) would — e.g. a Date -> its ISO string — instead of being
    // flattened to `{}` by the Object.entries walk below and silently lost on read/replay.
    const maybe = value as { toJSON?: (key?: unknown) => unknown };
    if (typeof maybe.toJSON === 'function') return sanitizePgJson(maybe.toJSON()) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizePgJson(v);
    }
    return out as T;
  }
  return value;
}
