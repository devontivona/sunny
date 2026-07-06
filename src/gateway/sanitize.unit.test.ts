import { describe, expect, it } from 'vitest';
import { sanitizePgJson, sanitizePgText } from './sanitize.js';

// Construct the problem code points without embedding literal control chars in source.
const NUL = String.fromCharCode(0x0000);
const LONE_HIGH = String.fromCharCode(0xd800); // a high surrogate with no low following
const REPLACEMENT = String.fromCharCode(0xfffd);

describe('sanitizePgText', () => {
  it('strips NUL bytes', () => {
    expect(sanitizePgText(`a${NUL}b${NUL}`)).toBe('ab');
  });

  it('replaces a lone surrogate with U+FFFD', () => {
    expect(sanitizePgText(`x${LONE_HIGH}y`)).toBe(`x${REPLACEMENT}y`);
  });

  it('keeps a valid surrogate pair (emoji) intact', () => {
    expect(sanitizePgText('done 😀')).toBe('done 😀');
  });

  it('is a no-op for clean text', () => {
    expect(sanitizePgText('hello world')).toBe('hello world');
  });
});

describe('sanitizePgJson', () => {
  it('deep-strips NUL from nested strings, arrays, and object values', () => {
    const input = { a: `x${NUL}`, b: [{ c: `y${NUL}z` }], n: 3, ok: true, nil: null };
    expect(sanitizePgJson(input)).toEqual({ a: 'x', b: [{ c: 'yz' }], n: 3, ok: true, nil: null });
  });

  it('does not mutate the input', () => {
    const input = { t: `p${NUL}` };
    sanitizePgJson(input);
    expect(input.t).toBe(`p${NUL}`);
  });

  it('preserves a Date as its ISO string (respects toJSON) instead of flattening to {}', () => {
    const iso = '2026-07-05T12:34:56.000Z';
    const input = { at: new Date(iso), nested: [{ when: new Date(iso) }] };
    // Matches JSONB serialization semantics (JSON.stringify(date) -> ISO string), so the
    // value round-trips on read/replay rather than becoming an empty object.
    expect(sanitizePgJson(input)).toEqual({ at: iso, nested: [{ when: iso }] });
  });

  it('serializes a top-level Date to its ISO string', () => {
    const iso = '2026-07-05T00:00:00.000Z';
    expect(sanitizePgJson(new Date(iso))).toBe(iso);
  });
});
