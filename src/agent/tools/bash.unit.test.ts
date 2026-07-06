import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfig } from '../../../tests/factories.js';
import { FakeResolver } from '../../../tests/fakes/credentials.js';
import { registerCredential } from '../../credentials/index.js';
import { editFileSafe, execBash, readFileSafe, runBash, writeFileSafe } from './bash.js';

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
  const tmp = () => mkdtempSync(join(tmpdir(), 'sunny-bash-'));

  it('reads a file as line-numbered output (cat -n style)', () => {
    const f = join(tmp(), 'note.txt');
    writeFileSync(f, 'hello world\nsecond line\n');
    expect(readFileSafe(f)).toBe(`     1\thello world\n     2\tsecond line`);
  });

  it('errors on a missing file', () => {
    expect(readFileSafe('/no/such/file/xyz')).toMatch(/^ERROR/);
  });

  it('errors on a directory', () => {
    expect(readFileSafe(tmpdir())).toMatch(/is a directory/);
  });

  it('windows with offset/limit and names the continuation offset', () => {
    const f = join(tmp(), 'many.txt');
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
    const out = readFileSafe(f, { offset: 3, limit: 2 });
    expect(out).toContain('     3\tline 3');
    expect(out).toContain('     4\tline 4');
    expect(out).not.toContain('line 5');
    expect(out).toContain('showing lines 3–4 of 10; continue with offset: 5');
  });

  it('errors when offset is past the end', () => {
    const f = join(tmp(), 'short.txt');
    writeFileSync(f, 'one\ntwo');
    expect(readFileSafe(f, { offset: 99 })).toMatch(/past the end .* \(2 lines\)/);
  });

  it('stops at the max_bytes backstop with a continuation note', () => {
    const f = join(tmp(), 'big.txt');
    writeFileSync(
      f,
      Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${'x'.repeat(50)}`).join('\n'),
    );
    const out = readFileSafe(f, { maxBytes: 300 });
    expect(out).toContain('     1\tline 1');
    expect(out).toMatch(/continue with offset: \d+/);
    expect(out.length).toBeLessThan(500);
  });

  it('clips very long individual lines', () => {
    const f = join(tmp(), 'wide.txt');
    writeFileSync(f, `short\n${'y'.repeat(5000)}`);
    const out = readFileSafe(f, { maxBytes: 1_000_000 });
    expect(out).toContain('…[line truncated]');
    expect(out).not.toContain('y'.repeat(2001));
  });

  it('refuses a binary file (NUL byte) instead of returning garbage', () => {
    // A binary file (e.g. a PDF read by path) contains NUL bytes; decoding it to text
    // yields garbage that poisons the durable turn's Postgres write. Refuse with a hint.
    const f = join(tmp(), 'doc.pdf');
    writeFileSync(f, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0x00]));
    const out = readFileSafe(f);
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/binary file/);
    expect(out).not.toContain(String.fromCharCode(0));
  });
});

describe('writeFileSafe', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'sunny-file-'));

  it('creates a file, making parent directories', () => {
    const f = join(tmp(), 'deep/nested/dir/new.txt');
    const out = writeFileSafe(f, 'alpha\nbeta');
    expect(out).toMatch(/^Wrote/);
    expect(out).toContain('2 lines');
    expect(readFileSync(f, 'utf8')).toBe('alpha\nbeta');
  });

  it('overwrites an existing file and says so', () => {
    const f = join(tmp(), 'note.txt');
    writeFileSync(f, 'old');
    expect(writeFileSafe(f, 'new')).toMatch(/^Overwrote/);
    expect(readFileSync(f, 'utf8')).toBe('new');
  });

  it('refuses to write over a directory', () => {
    const d = tmp();
    expect(writeFileSafe(d, 'x')).toMatch(/is a directory/);
    expect(existsSync(d)).toBe(true);
  });
});

describe('editFileSafe', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'sunny-file-'));
  const seed = (content: string) => {
    const f = join(tmp(), 'code.ts');
    writeFileSync(f, content);
    return f;
  };

  it('replaces a unique match and names the line', () => {
    const f = seed('const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const out = editFileSafe(f, 'const b = 2;', 'const b = 20;');
    expect(out).toContain('replaced 1 occurrence at line 2');
    expect(readFileSync(f, 'utf8')).toBe('const a = 1;\nconst b = 20;\nconst c = 3;\n');
  });

  it('refuses a zero-match edit and leaves the file untouched', () => {
    const f = seed('hello\n');
    const out = editFileSafe(f, 'goodbye', 'farewell');
    expect(out).toMatch(/^ERROR: old_string not found/);
    expect(readFileSync(f, 'utf8')).toBe('hello\n');
  });

  it('refuses a multi-match edit without replace_all, reporting the count', () => {
    const f = seed('x = 1\nx = 1\nx = 1\n');
    const out = editFileSafe(f, 'x = 1', 'x = 2');
    expect(out).toMatch(/matches 3 places/);
    expect(readFileSync(f, 'utf8')).toBe('x = 1\nx = 1\nx = 1\n');
  });

  it('replaces every occurrence with replace_all', () => {
    const f = seed('x = 1\nx = 1\nx = 1\n');
    const out = editFileSafe(f, 'x = 1', 'x = 2', true);
    expect(out).toContain('replaced 3 occurrences');
    expect(readFileSync(f, 'utf8')).toBe('x = 2\nx = 2\nx = 2\n');
  });

  it('refuses identical old/new strings and an empty old_string', () => {
    const f = seed('same\n');
    expect(editFileSafe(f, 'same', 'same')).toMatch(/identical/);
    expect(editFileSafe(f, '', 'x')).toMatch(/empty/);
  });

  it('refuses to edit a binary file', () => {
    const f = join(tmp(), 'bin.dat');
    writeFileSync(f, Buffer.from([0x01, 0x00, 0x02]));
    expect(editFileSafe(f, 'a', 'b')).toMatch(/binary file/);
  });

  it('errors on a missing file', () => {
    expect(editFileSafe('/no/such/file/xyz', 'a', 'b')).toMatch(/^ERROR/);
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
