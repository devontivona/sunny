import { describe, expect, it } from 'vitest';
import type { ModelMessage, UIMessage } from 'ai';
import { assistantUIMessageFromResponse, calledStaySilent } from './delivery.js';
import { makeAssistantTurnPayload } from '../../tests/factories.js';

describe('calledStaySilent', () => {
  it('detects a stay_silent tool call in the assembled parts', () => {
    const parts = [{ type: 'tool-stay_silent', toolCallId: 'x', state: 'output-available' }];
    expect(calledStaySilent(parts as UIMessage['parts'])).toBe(true);
  });

  it('is false for a normal send turn', () => {
    expect(calledStaySilent(makeAssistantTurnPayload({ sends: ['hi'] }).parts)).toBe(false);
  });
});

describe('assistantUIMessageFromResponse', () => {
  const toolCallIds = (msg: UIMessage | undefined) =>
    (msg?.parts ?? [])
      .filter((p) => p.type.startsWith('tool-'))
      .map((p) => (p as { toolCallId: string }).toolCallId);

  it('merges assistant text + tool calls across steps and matches tool outputs', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'on it' },
          { type: 'tool-call', toolCallId: 'a1', toolName: 'bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'a1',
            toolName: 'bash',
            output: { type: 'text', value: 'file.txt' },
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const msg = assistantUIMessageFromResponse(messages)!;
    expect(msg.parts.filter((p) => p.type === 'text').map((p) => (p as any).text)).toEqual([
      'on it',
      'done',
    ]);
    const toolPart = msg.parts.find((p) => p.type === 'tool-bash') as any;
    expect(toolPart.toolCallId).toBe('a1');
    expect(toolPart.output).toBe('file.txt');
  });

  it('never emits a duplicate tool_use id (the thread-poisoning regression)', () => {
    // Simulates the v6→v7 bug where the input window (prior turns) was merged back in, so the
    // same tool-call id appeared twice. Anthropic rejects that with "`tool_use` ids must be
    // unique", failing every later turn and storming the durable run. The guard de-dups.
    const dup: ModelMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'send-1', toolName: 'send_message', input: {} }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'send-1', toolName: 'send_message', input: {} }],
      },
    ];
    const ids = toolCallIds(assistantUIMessageFromResponse(dup));
    expect(ids).toEqual(['send-1']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
