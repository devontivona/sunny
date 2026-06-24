import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { sanitizeForRecovery } from './recovery.js';

/**
 * The delivery-recovery backstop feeds the turn's messages to a cheap Haiku call.
 * The raw trajectory carries the main model's reasoning (thinking) blocks plus
 * tool-call/tool-result parts; passing those to Haiku made it return EMPTY text in
 * production (ghosting the user). `sanitizeForRecovery` reduces messages to plain
 * text — these tests lock that shape so the fix can't silently regress.
 */
describe('sanitizeForRecovery', () => {
  it('keeps text content and drops reasoning / tool-call / tool-result parts', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'run uname' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', providerOptions: { anthropic: { signature: 'abc' } } },
          { type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: { command: 'uname -a' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'bash',
            output: { type: 'text', value: 'Linux' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', providerOptions: { anthropic: { signature: 'def' } } },
          { type: 'text', text: 'Linux janeway 5.15' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Fetch HN top story' }] },
    ] as unknown as ModelMessage[];

    const out = sanitizeForRecovery(messages);

    // The pure tool-call assistant turn and the tool-result turn are dropped; the
    // reasoning blocks are stripped; text survives.
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    for (const m of out) {
      const parts = m.content as Array<{ type: string }>;
      expect(parts.every((p) => p.type === 'text')).toBe(true);
    }
    expect((out.at(-1)!.content as Array<{ text: string }>)[0]!.text).toBe('Fetch HN top story');
  });

  it('keeps plain string messages and drops empty ones', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '   ' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'x', toolName: 'bash', input: {} }],
      },
    ] as unknown as ModelMessage[];

    const out = sanitizeForRecovery(messages);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('hello');
  });
});
