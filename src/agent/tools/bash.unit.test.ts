import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSafe, runBash } from './bash.js';

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
});
