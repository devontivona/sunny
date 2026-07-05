import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { renderTranscript } from './recovery.js';

/**
 * The delivery-recovery backstop renders the turn's messages as a labeled, third-
 * person transcript (instead of replaying them as native assistant/tool turns) so
 * the Haiku call doesn't identify as Sunny and continue the task — the production
 * ghosting bug. These tests lock the transcript shape: speaker labels, annotated
 * tool calls, and the omission of reasoning + raw tool-result payloads.
 */
describe('renderTranscript', () => {
  it('labels speakers, annotates tool calls, and omits reasoning / tool-results', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: "how's it going" }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'thinking...',
            providerOptions: { anthropic: { signature: 'x' } },
          },
          { type: 'text', text: 'going well — humming along' },
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
            output: { type: 'text', value: 'Linux janeway' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 't2',
            toolName: 'send_message',
            input: { text: 'Linux janeway' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'file', mediaType: 'image/jpeg', filename: 'card.jpg', data: 'data:...' },
        ],
      },
    ] as unknown as ModelMessage[];

    const out = renderTranscript(messages, 'Devon');

    expect(out.split('\n')).toEqual([
      "Devon: how's it going",
      'Sunny (said): going well — humming along',
      'Sunny [ran bash: uname -a]',
      'Sunny (sent): Linux janeway',
      'Devon: [sent an attachment]',
    ]);
    // No raw thinking or tool-result payloads leak in.
    expect(out).not.toContain('thinking');
    expect(out).not.toContain('tool-result');
  });

  it('truncates a long non-send tool input', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 't1',
            toolName: 'bash',
            input: { command: 'x'.repeat(200) },
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const out = renderTranscript(messages, 'Devon');
    expect(out).toMatch(/^Sunny \[ran bash: x+…\]$/);
    expect(out.length).toBeLessThan(120);
  });
});
