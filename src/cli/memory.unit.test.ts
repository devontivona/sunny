import { describe, expect, it } from 'vitest';
import { lint, lintIndex, renderLintReport } from './memory.js';

describe('lintIndex + renderLintReport', () => {
  it('reports both directions of drift', () => {
    const result = lintIndex('- travel: trips\n- gone: stale line\n', ['travel', 'orphan']);
    expect(result.missingFromIndex).toEqual(['orphan']);
    expect(result.staleIndexLines).toEqual(['gone']);
    expect(result.stubLines).toEqual([]);
  });

  it('flags auto-added stub lines needing a real description (not as stale)', () => {
    const result = lintIndex(
      '- travel: trips\n- comet: (stub — auto-added; describe this topic)\n',
      ['travel', 'comet'],
    );
    expect(result.stubLines).toEqual(['comet']);
    expect(result.staleIndexLines).toEqual([]);
    expect(result.missingFromIndex).toEqual([]);
  });

  it('is clean when INDEX matches topics', () => {
    const result = lintIndex('- travel: trips\n', ['travel']);
    expect(result).toEqual({ missingFromIndex: [], staleIndexLines: [], stubLines: [] });
    expect(renderLintReport(result)).toContain('consistent — clean');
  });

  it('renderLintReport emits one actionable line per finding', () => {
    const report = renderLintReport({
      missingFromIndex: ['a'],
      staleIndexLines: ['b'],
      stubLines: ['c'],
    });
    expect(report.split('\n')).toHaveLength(3);
    expect(report).not.toContain('clean');
  });
});

describe('lint (from-disk verify-after-fix loop)', () => {
  it('reads the live memory tree and reports clean after the drift is fixed', async () => {
    const { makeConfig } = await import('../../tests/factories.js');
    const { memoryPaths } = await import('../memory/index.js');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const config = makeConfig();
    const paths = memoryPaths(config.runtimeDir);
    mkdirSync(paths.topicsDir, { recursive: true });
    writeFileSync(paths.topic('orphan'), 'body\n');
    writeFileSync(paths.INDEX, '- gone: stale\n');

    const dirty = lint(config);
    expect(dirty).toContain('topic doc with NO INDEX line (add one): orphan');
    expect(dirty).toContain('INDEX line with NO topic doc (remove or fix): gone');

    writeFileSync(paths.INDEX, '- orphan: real description of the orphan doc\n');
    expect(lint(config)).toContain('consistent — clean');
  });
});
