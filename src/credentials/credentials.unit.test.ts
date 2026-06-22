import { describe, it, expect } from 'vitest';
import { makeConfig } from '../../tests/factories.js';
import { FakeResolver } from '../../tests/fakes/credentials.js';
import { execCredentialManage } from '../agent/tools/credentialManage.js';
import {
  isOpReference,
  listCredentials,
  loadRegistry,
  registerCredential,
  resolveByName,
} from './index.js';

describe('isOpReference', () => {
  it('accepts op://vault/item/field and section forms', () => {
    expect(isOpReference('op://Sunny/email/password')).toBe(true);
    expect(isOpReference('op://Sunny/email/smtp/password')).toBe(true);
    expect(isOpReference('  op://Sunny/email/password  ')).toBe(true);
  });

  it('rejects non-references and short paths', () => {
    expect(isOpReference('op://Sunny/email')).toBe(false);
    expect(isOpReference('Sunny/email/password')).toBe(false);
    expect(isOpReference('http://example.com')).toBe(false);
  });
});

describe('credential registry (D-CR5)', () => {
  const REF = 'op://Sunny/gmail/password';

  it('records name→reference (no value) and resolves by name', async () => {
    const { runtimeDir } = makeConfig();
    expect(listCredentials(runtimeDir)).toEqual([]);

    await registerCredential(runtimeDir, 'Gmail', REF, {
      purpose: 'email login',
      addedBy: 'Devon',
    });

    const reg = loadRegistry(runtimeDir);
    expect(reg.gmail).toEqual({ reference: REF, purpose: 'email login', addedBy: 'Devon' });
    expect(JSON.stringify(reg)).not.toContain('password-value'); // only the pointer is stored

    const resolver = new FakeResolver({ [REF]: 'the-secret' });
    expect(await resolveByName(resolver, runtimeDir, 'gmail')).toBe('the-secret');
    expect(resolver.seen).toEqual([REF]);
  });

  it('rejects an invalid reference', async () => {
    const { runtimeDir } = makeConfig();
    await expect(registerCredential(runtimeDir, 'x', 'not-a-ref')).rejects.toThrow(/valid op:/);
  });

  it('throws for an unknown name (prompting the owner to add it)', async () => {
    const { runtimeDir } = makeConfig();
    const resolver = new FakeResolver({});
    await expect(resolveByName(resolver, runtimeDir, 'missing')).rejects.toThrow(/ask the owner/);
  });
});

describe('credential_manage tool', () => {
  const REF = 'op://Sunny/gmail/password';

  it('lists empty, registers, and verifies via the resolver', async () => {
    const config = makeConfig();
    const resolver = new FakeResolver({ [REF]: 'pw' });

    expect(await execCredentialManage(config, resolver, { action: 'list' })).toBe(
      '(no credentials registered yet)',
    );

    const reg = await execCredentialManage(config, resolver, {
      action: 'register',
      name: 'gmail',
      reference: REF,
      purpose: 'email login',
    });
    expect(reg).toMatch(/verified it resolves/);

    expect(await execCredentialManage(config, resolver, { action: 'list' })).toContain(
      'gmail (email login) → op://Sunny/gmail/password',
    );
  });

  it('registers without verifying when no resolver is configured', async () => {
    const config = makeConfig();
    const out = await execCredentialManage(config, undefined, {
      action: 'register',
      name: 'gmail',
      reference: REF,
    });
    expect(out).toMatch(/not verified/);
  });

  it('flags a reference that does not resolve', async () => {
    const config = makeConfig();
    const resolver = new FakeResolver({}); // REF not present → rejects
    const out = await execCredentialManage(config, resolver, {
      action: 'register',
      name: 'gmail',
      reference: REF,
    });
    expect(out).toMatch(/did NOT resolve/);
  });

  it('rejects a malformed reference before writing', async () => {
    const config = makeConfig();
    const out = await execCredentialManage(config, new FakeResolver({}), {
      action: 'register',
      name: 'gmail',
      reference: 'bogus',
    });
    expect(out).toMatch(/not a valid op:/);
    expect(listCredentials(config.runtimeDir)).toEqual([]);
  });
});
