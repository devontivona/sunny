import { describe, expect, it } from 'vitest';
import { convertToModelMessages } from 'ai';
import { fewshotUIMessages } from './fewshot.js';

describe('fewshotUIMessages', () => {
  it('is a valid, convertible block: starts with user, tool calls pair with results', async () => {
    const block = fewshotUIMessages('Devon', 'baseline', false);
    expect(block[0]?.role).toBe('user');
    expect(block.at(-1)?.role).toBe('assistant');

    const messages = await convertToModelMessages(block, { ignoreIncompleteToolCalls: true });
    expect(messages[0]?.role).toBe('user');
    // Every tool call survives conversion with its paired result (a dangling call
    // would be dropped by ignoreIncompleteToolCalls and silently thin the block).
    const json = JSON.stringify(messages);
    for (const id of ['fewshot-1-send', 'fewshot-2-mem', 'fewshot-2-send', 'fewshot-3-silent']) {
      expect(json).toContain(id);
    }
    expect(messages.some((m) => m.role === 'tool')).toBe(true);
    // Exactly 3 canned assistant turns — the workflow test relies on this count.
    expect(block.filter((m) => m.role === 'assistant')).toHaveLength(3);
    // No reasoning parts (history is always replayed reasoning-stripped).
    expect(json).not.toContain('"reasoning"');
  });

  it('is static per (owner, variant, envelope) — a stable cacheable prefix', () => {
    expect(fewshotUIMessages('Devon', 'gateway', true)).toEqual(
      fewshotUIMessages('Devon', 'gateway', true),
    );
  });

  it('wraps user turns in the envelope when enabled', () => {
    const block = fewshotUIMessages('Devon', 'baseline', true);
    const firstUser = block[0]!.parts[0] as { text: string };
    expect(firstUser.text.startsWith('[iMessage from Devon] ')).toBe(true);
  });

  it('writes the scratch note in the active variant register', () => {
    // The scratch notes = the text parts of assistant turns (sends live in tool
    // inputs and are legitimately user-addressed; the note must never be).
    const notesOf = (v: 'baseline' | 'gateway' | 'diary') =>
      fewshotUIMessages('Devon', v, false)
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text));
    expect(notesOf('baseline')).not.toEqual(notesOf('diary'));
    expect(notesOf('gateway')).not.toEqual(notesOf('diary'));
    for (const v of ['baseline', 'gateway', 'diary'] as const) {
      for (const note of notesOf(v)) expect(note).not.toMatch(/\byou\b/i);
    }
  });
});
