import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyMemoryWrite, MemoryOverflowError, memoryPaths, sanitizeTopic } from './index.js';
import { makeConfig } from '../../tests/factories.js';

describe('sanitizeTopic', () => {
  it('slugs a normal name', () => {
    expect(sanitizeTopic('Travel Plans')).toBe('travel-plans');
  });

  it('strips path-traversal and separators (no `/`, no `..`)', () => {
    expect(sanitizeTopic('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeTopic('a/b/c')).toBe('a-b-c');
  });

  it('throws when nothing safe remains', () => {
    expect(() => sanitizeTopic('/////')).toThrow(/invalid topic name/);
  });

  it('keeps the resolved topic path inside the topics dir', () => {
    const paths = memoryPaths('/tmp/sunny-x');
    expect(paths.topic('../../escape')).toBe(`${paths.topicsDir}/escape.md`);
  });
});

describe('applyMemoryWrite — computeNext semantics', () => {
  function freshConfig() {
    return makeConfig(); // fresh temp runtime dir per call
  }

  it('add: appends content with a trailing newline', async () => {
    const config = freshConfig();
    await applyMemoryWrite(config, { file: 'USER', action: 'add', content: '- Likes tea' });
    await applyMemoryWrite(config, { file: 'USER', action: 'add', content: '- Lives in NYC' });
    const body = readFileSync(memoryPaths(config.runtimeDir).USER, 'utf8');
    expect(body).toBe('- Likes tea\n- Lives in NYC\n');
  });

  it('add: rejects empty content', async () => {
    const config = freshConfig();
    await expect(
      applyMemoryWrite(config, { file: 'USER', action: 'add', content: '   ' }),
    ).rejects.toThrow(/add requires content/);
  });

  it('replace with target: substitutes the matched substring', async () => {
    const config = freshConfig();
    await applyMemoryWrite(config, { file: 'SUNNY', action: 'add', content: 'tone: formal' });
    await applyMemoryWrite(config, {
      file: 'SUNNY',
      action: 'replace',
      target: 'formal',
      content: 'warm',
    });
    expect(readFileSync(memoryPaths(config.runtimeDir).SUNNY, 'utf8')).toBe('tone: warm\n');
  });

  it('replace without target: full-file replace (consolidation primitive)', async () => {
    const config = freshConfig();
    await applyMemoryWrite(config, { file: 'INDEX', action: 'add', content: 'old line' });
    await applyMemoryWrite(config, { file: 'INDEX', action: 'replace', content: 'fresh body' });
    expect(readFileSync(memoryPaths(config.runtimeDir).INDEX, 'utf8')).toBe('fresh body\n');
  });

  it('replace: throws when the target is absent', async () => {
    const config = freshConfig();
    await applyMemoryWrite(config, { file: 'USER', action: 'add', content: 'hello' });
    await expect(
      applyMemoryWrite(config, { file: 'USER', action: 'replace', target: 'absent', content: 'x' }),
    ).rejects.toThrow(/replace target not found/);
  });

  it('remove: deletes the matched substring', async () => {
    const config = freshConfig();
    await applyMemoryWrite(config, { file: 'USER', action: 'add', content: 'keep DROP keep' });
    await applyMemoryWrite(config, { file: 'USER', action: 'remove', target: ' DROP' });
    expect(readFileSync(memoryPaths(config.runtimeDir).USER, 'utf8')).toBe('keep keep\n');
  });

  it('routes a topic doc to topics/ (unbounded) via topic:<name>', async () => {
    const config = freshConfig();
    const res = await applyMemoryWrite(config, {
      file: 'topic:Travel Plans',
      action: 'add',
      content: 'flight booked',
    });
    expect(res).toMatch(/topics\/travel-plans\.md/);
    expect(readFileSync(memoryPaths(config.runtimeDir).topic('Travel Plans'), 'utf8')).toBe(
      'flight booked\n',
    );
  });

  it('rejects an unknown core file', async () => {
    const config = freshConfig();
    await expect(
      applyMemoryWrite(config, { file: 'NOPE', action: 'add', content: 'x' }),
    ).rejects.toThrow(/unknown memory file/);
  });
});

describe('core-file overflow', () => {
  it('throws MemoryOverflowError when a capped core file exceeds its cap', async () => {
    const config = makeConfig({
      memory: { userMaxChars: 20, sunnyMaxChars: 6000, indexMaxChars: 2000 },
    });
    await expect(
      applyMemoryWrite(config, {
        file: 'USER',
        action: 'add',
        content: 'x'.repeat(50),
      }),
    ).rejects.toBeInstanceOf(MemoryOverflowError);
  });

  it('topic docs are unbounded (no overflow)', async () => {
    const config = makeConfig({
      memory: { userMaxChars: 20, sunnyMaxChars: 20, indexMaxChars: 20 },
    });
    await expect(
      applyMemoryWrite(config, { file: 'topic:big', action: 'add', content: 'y'.repeat(500) }),
    ).resolves.toMatch(/ok:/);
  });
});
