import { describe, it, expect } from 'vitest';
import { FakeResolver } from '../../tests/fakes/credentials.js';
import { isOpReference, resolveEnv, scopeResolver } from './index.js';

describe('isOpReference', () => {
  it('accepts op://vault/item/field and section forms', () => {
    expect(isOpReference('op://Sunny/email/password')).toBe(true);
    expect(isOpReference('op://Sunny/email/smtp/password')).toBe(true);
    expect(isOpReference('  op://Sunny/email/password  ')).toBe(true);
  });

  it('rejects non-references and short paths', () => {
    expect(isOpReference('op://Sunny/email')).toBe(false); // missing field
    expect(isOpReference('Sunny/email/password')).toBe(false); // no scheme
    expect(isOpReference('http://example.com')).toBe(false);
    expect(isOpReference('not a ref')).toBe(false);
  });
});

describe('scopeResolver (per-tool whitelist, D-CR3)', () => {
  const REF = 'op://Sunny/email/password';

  it('resolves a whitelisted reference', async () => {
    const base = new FakeResolver({ [REF]: 's3cret' });
    const scoped = scopeResolver(base, [REF]);
    expect(await scoped.resolve(REF)).toBe('s3cret');
    expect(base.seen).toEqual([REF]);
  });

  it('refuses an undeclared reference without touching the underlying resolver', async () => {
    const base = new FakeResolver({ 'op://Sunny/other/token': 'nope' });
    const scoped = scopeResolver(base, [REF]);
    await expect(scoped.resolve('op://Sunny/other/token')).rejects.toThrow(/not permitted/);
    expect(base.seen).toEqual([]); // never reached the real resolver
  });

  it('refuses an arbitrary path the model might inject', async () => {
    const base = new FakeResolver({ 'op://Private/anything/field': 'leak' });
    const scoped = scopeResolver(base, [REF]);
    await expect(scoped.resolve('op://Private/anything/field')).rejects.toThrow(/not permitted/);
    expect(base.seen).toEqual([]);
  });
});

describe('resolveEnv (op-run injection, D-TA5)', () => {
  it('maps env vars to resolved values through a scoped resolver', async () => {
    const REF = 'op://Sunny/email/password';
    const base = new FakeResolver({ [REF]: 'pw' });
    const scoped = scopeResolver(base, [REF]);
    expect(await resolveEnv(scoped, { EMAIL_PASSWORD: REF })).toEqual({ EMAIL_PASSWORD: 'pw' });
  });

  it('propagates a whitelist refusal', async () => {
    const base = new FakeResolver({});
    const scoped = scopeResolver(base, []);
    await expect(resolveEnv(scoped, { X: 'op://Sunny/x/y' })).rejects.toThrow(/not permitted/);
  });
});
