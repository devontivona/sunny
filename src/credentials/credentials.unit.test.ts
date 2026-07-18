import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { makeConfig } from '../../tests/factories.js';
import { FakeResolver } from '../../tests/fakes/credentials.js';
import { execCredentialManage } from '../agent/tools/credentialManage.js';
import {
  buildReference,
  credentialsPath,
  deleteCredential,
  isOpReference,
  listCredentials,
  loadRegistry,
  registerCredential,
  resolveByName,
  updateCredential,
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

  it('rejects a reference built from display names with spaces/symbols', () => {
    expect(isOpReference('op://Katie & Devon/Gmail (Sunny)/password')).toBe(false);
  });
});

describe('buildReference (id-based, resolves despite display-name symbols)', () => {
  it('builds an alphanumeric, resolvable reference from ids', () => {
    const ref = buildReference('abc123vaultid', 'def456itemid', 'password');
    expect(ref).toBe('op://abc123vaultid/def456itemid/password');
    expect(isOpReference(ref)).toBe(true);
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

describe('credential registry corruption safety (D-CR5)', () => {
  it('quarantines a corrupt credentials.json and refuses to overwrite it to empty', async () => {
    const { runtimeDir } = makeConfig();
    // A real mapping, then the file corrupted on disk (torn write / bad hand-edit).
    await registerCredential(runtimeDir, 'gmail', 'op://Sunny/gmail/password');
    const file = credentialsPath(runtimeDir);
    writeFileSync(file, '{ this is not valid json', 'utf8');

    // The next registration must NOT silently treat the corrupt file as empty and
    // then persist that empty view (erasing every mapping).
    await expect(registerCredential(runtimeDir, 'other', 'op://Sunny/other/token')).rejects.toThrow(
      /corrupt/,
    );

    // The corrupt bytes are preserved in a quarantine sibling, not lost.
    const dir = dirname(file);
    const backup = readdirSync(dir).find((f) => f.startsWith('credentials.json.corrupt-'));
    expect(backup).toBeDefined();
    expect(readFileSync(join(dir, backup!), 'utf8')).toContain('this is not valid json');
  });

  it('writes atomically — no torn temp file is left behind', async () => {
    const { runtimeDir } = makeConfig();
    await registerCredential(runtimeDir, 'gmail', 'op://Sunny/gmail/password');
    const dir = dirname(credentialsPath(runtimeDir));
    expect(readdirSync(dir).filter((f) => f.includes('credentials.json.tmp-'))).toEqual([]);
  });
});

describe('credential_manage tool', () => {
  const REF = 'op://Sunny/gmail/password';

  it('discovers op:// references from the vault (titles only, no values)', async () => {
    const config = makeConfig();
    const resolver = new FakeResolver({}, [
      {
        vault: 'Sunny',
        item: 'gmail',
        fields: [
          { field: 'username', reference: 'op://Sunny/gmail/username' },
          { field: 'password', reference: 'op://Sunny/gmail/password' },
        ],
      },
    ]);
    const out = await execCredentialManage(config, resolver, { action: 'discover' });
    expect(out).toContain('Sunny / gmail:');
    expect(out).toContain('password → op://Sunny/gmail/password');
  });

  it('discover errors without a resolver', async () => {
    const config = makeConfig();
    expect(await execCredentialManage(config, undefined, { action: 'discover' })).toMatch(
      /no 1Password token/,
    );
  });

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
    expect(out).toMatch(/not a resolvable reference/);
    expect(listCredentials(config.runtimeDir)).toEqual([]);
  });
});

describe('credential registry edit/delete', () => {
  const REF = 'op://Sunny/gmail/password';
  const REF2 = 'op://Sunny/gmail2/password';

  it('deletes a mapping and errors on an unknown name (never a silent no-op)', async () => {
    const config = makeConfig();
    await registerCredential(config.runtimeDir, 'gmail', REF);
    const removed = await deleteCredential(config.runtimeDir, 'gmail');
    expect(removed).toMatchObject({ name: 'gmail', reference: REF });
    expect(listCredentials(config.runtimeDir)).toEqual([]);
    await expect(deleteCredential(config.runtimeDir, 'gmail')).rejects.toThrow(/no credential/);
  });

  it('edits in place: rename + repoint + purpose', async () => {
    const config = makeConfig();
    await registerCredential(config.runtimeDir, 'amex', REF, { purpose: 'household account' });
    const updated = await updateCredential(config.runtimeDir, 'amex', {
      newName: 'amex-kate',
      reference: REF2,
      purpose: "Kate's login",
    });
    expect(updated).toMatchObject({ name: 'amex-kate', reference: REF2, purpose: "Kate's login" });
    const names = listCredentials(config.runtimeDir).map((c) => c.name);
    expect(names).toEqual(['amex-kate']); // old name gone, no duplicate left behind
  });

  it('edit refuses to clobber an existing name and errors on an unknown name', async () => {
    const config = makeConfig();
    await registerCredential(config.runtimeDir, 'a', REF);
    await registerCredential(config.runtimeDir, 'b', REF2);
    await expect(updateCredential(config.runtimeDir, 'a', { newName: 'b' })).rejects.toThrow(
      /already exists/,
    );
    await expect(updateCredential(config.runtimeDir, 'nope', { purpose: 'x' })).rejects.toThrow(
      /no credential/,
    );
  });

  it('edit rejects an invalid replacement reference', async () => {
    const config = makeConfig();
    await registerCredential(config.runtimeDir, 'a', REF);
    await expect(updateCredential(config.runtimeDir, 'a', { reference: 'bogus' })).rejects.toThrow(
      /not a valid op:\/\/ reference/,
    );
  });
});

describe('credential_manage tool — edit/delete/save actions', () => {
  const REF = 'op://Sunny/gmail/password';

  it('delete reports what was removed, and errors on an unknown name', async () => {
    const config = makeConfig();
    await registerCredential(config.runtimeDir, 'gmail', REF);
    const out = await execCredentialManage(config, undefined, { action: 'delete', name: 'gmail' });
    expect(out).toContain('Deleted "gmail"');
    expect(out).toContain(REF);
    const again = await execCredentialManage(config, undefined, {
      action: 'delete',
      name: 'gmail',
    });
    expect(again).toMatch(/^ERROR: no credential/);
  });

  it('edit renames and re-verifies a repointed reference', async () => {
    const config = makeConfig();
    const resolver = new FakeResolver({ [REF]: 'pw' });
    await registerCredential(config.runtimeDir, 'amex', 'op://Sunny/old/password');
    const out = await execCredentialManage(config, resolver, {
      action: 'edit',
      name: 'amex',
      newName: 'amex-devon',
      reference: REF,
    });
    expect(out).toContain('Updated "amex-devon" (renamed from "amex")');
    expect(out).toMatch(/verified it resolves/);
  });

  it('edit requires at least one change', async () => {
    const config = makeConfig();
    await registerCredential(config.runtimeDir, 'a', REF);
    expect(await execCredentialManage(config, undefined, { action: 'edit', name: 'a' })).toMatch(
      /at least one of/,
    );
  });

  it('save creates the vault item and auto-registers the returned reference', async () => {
    const config = makeConfig();
    const resolver = new FakeResolver();
    const out = await execCredentialManage(config, resolver, {
      action: 'save',
      name: 'ignav',
      title: 'Ignav (Sunny-created)',
      username: 'devon@tivona.me',
      secretValue: 'generated-password-123',
      purpose: 'ignav login',
    });
    expect(out).toContain('Saved "Ignav (Sunny-created)"');
    expect(out).toContain('registered "ignav"');
    expect(resolver.created).toHaveLength(1);
    expect(resolver.created[0]).toMatchObject({ secretValue: 'generated-password-123' });
    const [entry] = listCredentials(config.runtimeDir);
    expect(entry).toMatchObject({ name: 'ignav', purpose: 'ignav login' });
    expect(entry!.reference).toMatch(/^op:\/\//);
  });

  it('save fails cleanly without a resolver or without vault-write support', async () => {
    const config = makeConfig();
    expect(
      await execCredentialManage(config, undefined, {
        action: 'save',
        name: 'x',
        secretValue: 'v',
      }),
    ).toMatch(/no 1Password token/);
    const readOnly = { resolve: () => Promise.resolve('v') };
    expect(
      await execCredentialManage(config, readOnly, { action: 'save', name: 'x', secretValue: 'v' }),
    ).toMatch(/not available/);
    expect(
      await execCredentialManage(config, new FakeResolver(), { action: 'save', name: 'x' }),
    ).toMatch(/requires secretValue/);
  });
});
