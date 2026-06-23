import { describe, expect, it } from 'vitest';
import { createRedactor, DEFAULT_SECRET_PATTERNS } from './redact.js';

describe('createRedactor — literal secrets', () => {
  it('scrubs a registered secret wherever it appears as a substring', () => {
    const r = createRedactor({ secrets: ['super-secret-value'] });
    expect(r.redactString('token=super-secret-value;')).toBe('token=[REDACTED];');
    expect(r.redactString('no secrets here')).toBe('no secrets here');
  });

  it('replaces every occurrence, not just the first', () => {
    const r = createRedactor({ secrets: ['abcdef'] });
    expect(r.redactString('abcdef and abcdef')).toBe('[REDACTED] and [REDACTED]');
  });

  it('ignores trivially short / empty values (no blanking the output)', () => {
    const r = createRedactor({ secrets: ['x', '', 'ok'], minLength: 6 });
    expect(r.redactString('x ok value')).toBe('x ok value');
  });

  it('scrubs the longest secret first when one contains another', () => {
    const r = createRedactor({ secrets: ['secret', 'secret-extended'] });
    expect(r.redactString('secret-extended')).toBe('[REDACTED]');
  });

  it('treats secret values as literals, not regex', () => {
    const r = createRedactor({ secrets: ['a.b*c(d)'] });
    expect(r.redactString('val=a.b*c(d)')).toBe('val=[REDACTED]');
    expect(r.redactString('val=axbxcd')).toBe('val=axbxcd');
  });
});

describe('createRedactor — recursive structure', () => {
  it('redacts strings nested in objects and arrays, preserving keys/shape', () => {
    const r = createRedactor({ secrets: ['TOPSECRET'] });
    const input = {
      msg: 'ok',
      auth: { token: 'TOPSECRET', list: ['x', 'TOPSECRET'] },
      n: 42,
      ok: true,
    };
    expect(r.redact(input)).toEqual({
      msg: 'ok',
      auth: { token: '[REDACTED]', list: ['x', '[REDACTED]'] },
      n: 42,
      ok: true,
    });
  });

  it('does not mangle class instances like Error beyond leaving them intact', () => {
    const r = createRedactor({ secrets: ['nope'] });
    const err = new Error('boom');
    expect(r.redact(err)).toBe(err);
  });

  it('survives circular references', () => {
    const r = createRedactor({ secrets: ['zzzzzz'] });
    const a: Record<string, unknown> = { v: 'zzzzzz' };
    a.self = a;
    const out = r.redact(a) as Record<string, unknown>;
    expect(out.v).toBe('[REDACTED]');
  });

  it('returns primitives untouched', () => {
    const r = createRedactor({ secrets: ['secretval'] });
    expect(r.redact(7)).toBe(7);
    expect(r.redact(null)).toBe(null);
    expect(r.redact(undefined)).toBe(undefined);
  });
});

describe('default secret patterns', () => {
  // No registered literals — patterns alone must catch credential-shaped values.
  const r = createRedactor({ secrets: [] });

  it('redacts Anthropic API keys', () => {
    expect(r.redactString('key sk-ant-api03-AbCdEf123_xyz here')).toBe('key [REDACTED] here');
  });

  it('redacts 1Password Service Account tokens', () => {
    expect(r.redactString('ops_eyJhbGciOiJ12345678901234567890')).toBe('[REDACTED]');
  });

  it('drops credentials from a postgres connection string but keeps host/db', () => {
    expect(r.redactString('postgres://user:p4ss@localhost:5544/sunny')).toBe(
      'postgres://[REDACTED]@localhost:5544/sunny',
    );
  });

  it('redacts Authorization header tokens', () => {
    expect(r.redactString('Authorization: Bearer abc123DEF456ghi')).toBe(
      'Authorization: [REDACTED]',
    );
    expect(r.redactString('Authorization: Basic cHViOnNlY3JldA==')).toBe(
      'Authorization: [REDACTED]',
    );
  });

  it('all default patterns carry the global flag (replace-all safe)', () => {
    for (const { re } of DEFAULT_SECRET_PATTERNS) expect(re.flags).toContain('g');
  });
});
