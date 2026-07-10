import { describe, expect, it } from 'vitest';
import {
  estimateRowTokens,
  IDLE_MARKER,
  lintIndex,
  renderDigest,
  renderThreadSection,
  spokenHead,
  suggestBoundary,
  toolTraceLines,
  whoOf,
  type DigestInput,
  type ThreadSection,
} from './dream.js';

const T0 = new Date('2026-07-09T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function row(over: Partial<ThreadSection['rows'][number]> = {}): ThreadSection['rows'][number] {
  return {
    threadId: 'sendblue:a:b',
    messageId: 'm1',
    role: 'user',
    senderId: '+15551230000',
    senderName: 'Devon',
    isOwner: true,
    text: 'hello there',
    payload: null,
    createdAt: T0,
    ...over,
  };
}

function section(over: Partial<ThreadSection> = {}): ThreadSection {
  return { threadId: 'sendblue:a:b', rows: [row()], priorSummary: null, suggestion: null, ...over };
}

function input(over: Partial<DigestInput> = {}): DigestInput {
  return {
    now: at(120),
    watermark: null,
    threads: [section()],
    indexLint: { missingFromIndex: [], staleIndexLines: [] },
    partial: false,
    coveredThrough: { threadId: 'sendblue:a:b', messageId: 'm1', createdAt: T0 },
    tokenTarget: 100_000,
    repoRoot: '/repo',
    ...over,
  };
}

describe('renderDigest', () => {
  it('prints the IDLE marker when no threads have new content', () => {
    const out = renderDigest(input({ threads: [], coveredThrough: null }));
    expect(out).toContain(IDLE_MARKER);
  });

  it('renders attribution, ids, and the exact advance command', () => {
    const out = renderDigest(input());
    expect(out).toContain('[id:m1]');
    expect(out).toContain('Devon (owner)');
    expect(out).toContain(
      "npx tsx src/cli/index.ts dream advance --thread 'sendblue:a:b' --message 'm1'",
    );
  });

  it('attribution routes memory deterministically: owner tag vs people handle (whoOf)', () => {
    expect(
      whoOf({ role: 'user', senderId: '+15551230000', senderName: 'Devon', isOwner: true }),
    ).toBe('Devon (owner)');
    // A non-owner participant carries the people-doc handle the dream writes facts to —
    // the same personId derivation the runtime uses for people:<id> docs.
    expect(
      whoOf({ role: 'user', senderId: '+17193146820', senderName: 'Kate', isOwner: false }),
    ).toBe('Kate [people:17193146820]');
    expect(
      whoOf({ role: 'assistant', senderId: 'sunny', senderName: 'Sunny', isOwner: false }),
    ).toBe('Sunny');
  });

  it('marks a capped span PARTIAL (oldest-first cover)', () => {
    const out = renderDigest(input({ partial: true }));
    expect(out).toContain('PARTIAL');
    expect(out).toContain('OLDEST content first');
  });

  it('renders the INDEX lint diff in both directions', () => {
    const out = renderDigest(
      input({ indexLint: { missingFromIndex: ['orphan-topic'], staleIndexLines: ['gone-topic'] } }),
    );
    expect(out).toContain('topic doc with NO INDEX line (add one): orphan-topic');
    expect(out).toContain('INDEX line with NO topic doc (remove or fix): gone-topic');
  });
});

describe('renderThreadSection', () => {
  it('inserts lull markers above the threshold and none below it', () => {
    const out = renderThreadSection(
      section({
        rows: [
          row({ messageId: 'a', createdAt: at(0) }),
          row({ messageId: 'b', createdAt: at(10) }), // 10m — no marker
          row({ messageId: 'c', createdAt: at(10 + 192) }), // 3.2h — marker
        ],
      }),
      100_000,
    );
    expect(out).toContain('— lull: 3.2h —');
    expect(out.match(/— lull:/g)?.length).toBe(1);
  });

  it('renders the prior compaction summary as fold-forward context', () => {
    const out = renderThreadSection(
      section({ priorSummary: { summary: 'covered: taxes, trip', boundaryCreatedAt: T0 } }),
      100_000,
    );
    expect(out).toContain("fold it forward, don't lose it");
    expect(out).toContain('| covered: taxes, trip');
  });

  it('renders attachment name + saved path lines', () => {
    const out = renderThreadSection(
      section({
        rows: [
          row({
            payload: {
              parts: [
                {
                  type: 'data-attachment',
                  data: { name: 'doc.pdf', mediaType: 'application/pdf', path: '/m/in/1/0.pdf' },
                },
              ],
            },
          }),
        ],
      }),
      100_000,
    );
    expect(out).toContain('attachment: doc.pdf (application/pdf) — saved at /m/in/1/0.pdf');
  });

  it('frames the suggestion as a ceiling, flagging a user-row boundary', () => {
    const assistant = renderThreadSection(
      section({
        suggestion: {
          messageId: 'x',
          createdAt: T0,
          role: 'assistant',
          tailTokens: 98_000,
          totalTokens: 240_000,
        },
      }),
      100_000,
    );
    expect(assistant).toContain('Suggested compaction boundary: [id:x]');
    expect(assistant).toContain('CEILING');
    expect(assistant).toContain('an assistant turn');

    const user = renderThreadSection(
      section({
        suggestion: {
          messageId: 'y',
          createdAt: T0,
          role: 'user',
          tailTokens: 90_000,
          totalTokens: 150_000,
        },
      }),
      100_000,
    );
    expect(user).toContain('cut EARLIER, after an assistant turn');
  });

  it('says no compaction needed when the tail is under target', () => {
    expect(renderThreadSection(section({ suggestion: null }), 100_000)).toContain(
      'no compaction needed',
    );
  });
});

describe('suggestBoundary', () => {
  const mk = (id: string, min: number, tokens: number, role = 'assistant') => ({
    messageId: id,
    createdAt: at(min),
    role,
    tokens,
  });

  it('picks the newest row whose exclusion leaves ≈ target tail', () => {
    // newest-first: tail accumulates 40k, 80k, 120k → boundary at the third row.
    const rows = [mk('n3', 30, 40_000), mk('n2', 20, 40_000), mk('n1', 10, 40_000)];
    const s = suggestBoundary(rows, 100_000, at(60));
    expect(s?.messageId).toBe('n1');
    expect(s?.tailTokens).toBe(80_000);
    expect(s?.totalTokens).toBe(120_000);
  });

  it('returns null when the tail never reaches target', () => {
    expect(suggestBoundary([mk('a', 0, 10_000)], 100_000, at(60))).toBeNull();
  });

  it('never suggests a row fresher than the margin cutoff', () => {
    // Both rows cross the target, but the newest is inside the fresh window.
    const rows = [mk('fresh', 50, 120_000), mk('old', 10, 120_000)];
    const s = suggestBoundary(rows, 100_000, at(30));
    expect(s?.messageId).toBe('old');
  });
});

describe('lintIndex', () => {
  it('reports both directions of drift', () => {
    const lint = lintIndex('- travel: trips\n- gone: stale line\n', ['travel', 'orphan']);
    expect(lint.missingFromIndex).toEqual(['orphan']);
    expect(lint.staleIndexLines).toEqual(['gone']);
  });

  it('is clean when INDEX matches topics', () => {
    const lint = lintIndex('- travel: trips\n', ['travel']);
    expect(lint.missingFromIndex).toEqual([]);
    expect(lint.staleIndexLines).toEqual([]);
  });
});

describe('row rendering helpers', () => {
  it('spokenHead drops the projection tool-extract section and clips long text', () => {
    expect(spokenHead('said this\n[tool results]\n[bash] wall of output')).toBe('said this');
    expect(spokenHead('x'.repeat(10_000))).toContain('(clipped)');
  });

  it('toolTraceLines renders bounded per-tool lines with an overflow note', () => {
    const parts = Array.from({ length: 15 }, (_, i) => ({
      type: 'tool-bash',
      input: { command: `cmd-${i} ${'y'.repeat(400)}` },
    }));
    const lines = toolTraceLines({ parts });
    expect(lines.filter((l) => l.startsWith('    tool bash:'))).toHaveLength(12);
    expect(lines.at(-1)).toContain('3 more tool calls');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(200);
  });

  it('estimateRowTokens prefers the payload size and falls back to text', () => {
    expect(estimateRowTokens({ text: 'x'.repeat(400), payload: null })).toBe(100);
    expect(
      estimateRowTokens({
        text: 'hi',
        payload: { parts: [{ type: 'text', text: 'y'.repeat(400) }] },
      }),
    ).toBeGreaterThan(100);
  });
});
