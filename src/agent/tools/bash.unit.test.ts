import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfig } from '../../../tests/factories.js';
import { FakeResolver } from '../../../tests/fakes/credentials.js';
import { registerCredential } from '../../credentials/index.js';
import { execBash, readFileSafe, runBash } from './bash.js';

const CWD = process.cwd();

describe('runBash', () => {
  it('returns stdout and exit 0', async () => {
    const out = await runBash('echo hello', CWD, 5000);
    expect(out).toContain('exit: 0');
    expect(out).toContain('hello');
  });

  it('reports a non-zero exit code', async () => {
    expect(await runBash('exit 3', CWD, 5000)).toContain('exit: 3');
  });

  it('captures stderr', async () => {
    expect(await runBash('echo oops 1>&2', CWD, 5000)).toMatch(/stderr:[\s\S]*oops/);
  });

  it('truncates very large output', async () => {
    const out = await runBash(`node -e "process.stdout.write('x'.repeat(40000))"`, CWD, 10000);
    expect(out).toMatch(/truncated \d+ chars/);
  });

  it('times out a long-running command', async () => {
    expect(await runBash('sleep 2', CWD, 100)).toMatch(/timed out/);
  });
});

describe('readFileSafe', () => {
  it('reads a file', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'sunny-bash-')), 'note.txt');
    writeFileSync(f, 'hello world');
    expect(readFileSafe(f)).toBe('hello world');
  });

  it('errors on a missing file', () => {
    expect(readFileSafe('/no/such/file/xyz')).toMatch(/^ERROR/);
  });

  it('errors on a directory', () => {
    expect(readFileSafe(tmpdir())).toMatch(/is a directory/);
  });

  it('truncates past max_bytes', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'sunny-bash-')), 'big.txt');
    writeFileSync(f, 'x'.repeat(500));
    expect(readFileSafe(f, 100)).toMatch(/truncated 400 of 500 bytes/);
  });

  it('refuses a binary file (NUL byte) instead of returning garbage', () => {
    // A binary file (e.g. a PDF read by path) contains NUL bytes; decoding it to text
    // yields garbage that poisons the durable turn's Postgres write. Refuse with a hint.
    const f = join(mkdtempSync(join(tmpdir(), 'sunny-bash-')), 'doc.pdf');
    writeFileSync(f, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0x00]));
    const out = readFileSafe(f);
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/binary file/);
    expect(out).not.toContain(String.fromCharCode(0));
  });
});

describe('execBash credential injection (D-TA5)', () => {
  const REF = 'op://Sunny/gmail/password';

  it('injects a vault secret into the env and masks it from output', async () => {
    const config = makeConfig();
    await registerCredential(config.runtimeDir, 'gmail', REF);
    const resolver = new FakeResolver({ [REF]: 'topsecret' });

    const out = await execBash(config, resolver, {
      command: 'echo "[$EMAIL_PW]"',
      credentials: { EMAIL_PW: 'gmail' },
    });
    expect(out).toContain('[«redacted»]'); // value used by the command but masked
    expect(out).not.toContain('topsecret'); // never leaks to the model
  });

  it('errors when a credential is requested but no resolver is configured', async () => {
    const config = makeConfig();
    const out = await execBash(config, undefined, {
      command: 'echo hi',
      credentials: { X: 'gmail' },
    });
    expect(out).toMatch(/no 1Password token/);
  });

  it('errors on an unknown credential name', async () => {
    const config = makeConfig();
    const out = await execBash(config, new FakeResolver({}), {
      command: 'echo hi',
      credentials: { X: 'nope' },
    });
    expect(out).toMatch(/resolving credential "nope"/);
  });

  it("strips Sunny's own secrets from the subprocess env", async () => {
    const config = makeConfig();
    process.env.OP_SERVICE_ACCOUNT_TOKEN = 'should-not-leak';
    try {
      const out = await execBash(config, undefined, {
        command: 'echo "[$OP_SERVICE_ACCOUNT_TOKEN]"',
      });
      expect(out).toContain('[]'); // stripped → empty
      expect(out).not.toContain('should-not-leak');
    } finally {
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    }
  });
});
