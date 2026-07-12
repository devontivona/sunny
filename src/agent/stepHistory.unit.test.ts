import { describe, expect, it } from 'vitest';
import type { ModelMessage } from './aiTypes.js';
import {
  estimateStepsCostUsd,
  moveCacheBreakpoint,
  restoreNarration,
  type StepContentLike,
} from './stepHistory.js';

// The upstream loop's tool-calls assistant message: tool calls only, text dropped.
function assistantToolCall(id: string): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: id, toolName: 'bash', input: { command: 'ls' } }],
  } as ModelMessage;
}

function toolResult(id: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'bash',
        output: { type: 'text', value: 'ok' },
      },
    ],
  } as ModelMessage;
}

function step(text: string | null, callId: string): StepContentLike {
  return {
    content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool-call', toolCallId: callId }],
  };
}

const parts = (m: ModelMessage) => m.content as Array<{ type: string; text?: string }>;

describe('restoreNarration', () => {
  it('re-injects a step’s text before its tool calls', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'do the task' },
      assistantToolCall('c1'),
      toolResult('c1'),
    ];
    const { messages: out, changed } = restoreNarration(messages, [
      step('Found the root cause. Implementing now.', 'c1'),
    ]);
    expect(changed).toBe(true);
    expect(parts(out[1]!)[0]).toEqual({
      type: 'text',
      text: 'Found the root cause. Implementing now.',
    });
    expect(parts(out[1]!)[1]!.type).toBe('tool-call');
  });

  it('is idempotent: a message that already has text is untouched', () => {
    const messages: ModelMessage[] = [assistantToolCall('c1'), toolResult('c1')];
    const steps = [step('note', 'c1')];
    const once = restoreNarration(messages, steps).messages;
    const twice = restoreNarration(once, steps);
    expect(twice.changed).toBe(false);
    expect(parts(twice.messages[0]!).filter((p) => p.type === 'text')).toHaveLength(1);
  });

  it('leaves text-less steps and non-assistant messages alone', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      assistantToolCall('c1'),
      toolResult('c1'),
    ];
    const { messages: out, changed } = restoreNarration(messages, [step(null, 'c1')]);
    expect(changed).toBe(false);
    expect(out).toBe(messages);
  });

  it('matches steps to messages by toolCallId, not position', () => {
    const messages: ModelMessage[] = [
      assistantToolCall('c1'),
      toolResult('c1'),
      assistantToolCall('c2'),
      toolResult('c2'),
    ];
    const { messages: out } = restoreNarration(messages, [
      step(null, 'c1'),
      step('second step note', 'c2'),
    ]);
    expect(parts(out[0]!).some((p) => p.type === 'text')).toBe(false);
    expect(parts(out[2]!)[0]).toMatchObject({ type: 'text', text: 'second step note' });
  });
});

describe('moveCacheBreakpoint', () => {
  const cc = (m: ModelMessage) =>
    (m.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl;

  it('marks the last message and clears its own previous mark', () => {
    let messages: ModelMessage[] = [
      { role: 'user', content: 'task' },
      assistantToolCall('c1'),
      toolResult('c1'),
    ];
    const first = moveCacheBreakpoint(messages, -1);
    expect(first.index).toBe(2);
    expect(cc(first.messages[2]!)).toEqual({ type: 'ephemeral' });

    messages = [...first.messages, assistantToolCall('c2'), toolResult('c2')];
    const second = moveCacheBreakpoint(messages, first.index);
    expect(second.index).toBe(4);
    expect(cc(second.messages[2]!)).toBeUndefined();
    expect(cc(second.messages[4]!)).toEqual({ type: 'ephemeral' });
  });

  it('never touches breakpoints it did not set (profile statics)', () => {
    const staticMarked: ModelMessage = {
      role: 'user',
      content: 'window tail',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    } as ModelMessage;
    const messages: ModelMessage[] = [staticMarked, assistantToolCall('c1'), toolResult('c1')];
    const { messages: out } = moveCacheBreakpoint(messages, -1);
    expect(cc(out[0]!)).toEqual({ type: 'ephemeral' });
    expect(cc(out[2]!)).toEqual({ type: 'ephemeral' });
  });

  it('preserves other anthropic provider options when clearing', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    const first = moveCacheBreakpoint(
      [
        {
          role: 'user',
          content: 'a',
          providerOptions: { anthropic: { foo: 'bar' } },
        } as unknown as ModelMessage,
        messages[1]!,
      ],
      -1,
    );
    const cleared = moveCacheBreakpoint([...first.messages, { role: 'user', content: 'c' }], 1);
    expect(cleared.index).toBe(2);
    expect((first.messages[0]!.providerOptions?.anthropic as Record<string, unknown>).foo).toBe(
      'bar',
    );
  });
});

describe('estimateStepsCostUsd', () => {
  const rates = { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 };

  it('prices cache reads, cache writes, uncached input, and output separately', () => {
    const steps: StepContentLike[] = [
      {
        content: [],
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          inputTokenDetails: {
            noCacheTokens: 100_000,
            cacheReadTokens: 800_000,
            cacheWriteTokens: 100_000,
          },
        },
      },
    ];
    // 800k read * 0.2 + 100k write * 2.5 + 100k plain * 2 + 100k out * 10
    expect(estimateStepsCostUsd(steps, rates)).toBeCloseTo(0.16 + 0.25 + 0.2 + 1.0, 5);
  });

  it('with no input split, prices ALL input at the cache-write rate (overcount, never under)', () => {
    const steps: StepContentLike[] = [
      { content: [] },
      { content: [], usage: { inputTokens: 1_000_000, outputTokens: 0 } },
      { content: [], usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    ];
    expect(estimateStepsCostUsd(steps, rates)).toBeCloseTo(5.0, 5);
  });

  it('clamps the split to inputTokens (defensive against inconsistent usage)', () => {
    const steps: StepContentLike[] = [
      {
        content: [],
        usage: {
          inputTokens: 100,
          outputTokens: 0,
          inputTokenDetails: { cacheReadTokens: 200, cacheWriteTokens: 200 },
        },
      },
    ];
    expect(estimateStepsCostUsd(steps, rates)).toBeCloseTo((100 * 0.2) / 1e6, 12);
  });
});
