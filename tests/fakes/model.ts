import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type {
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';

/** The provider's unified finish-reason label (the object's `unified` field). */
export type FinishReason = LanguageModelV4FinishReason['unified'];

/**
 * Mock language model fixture (design D2 / task 2.1).
 *
 * Wraps the AI SDK's `MockLanguageModelV4` so a test can script a turn as a
 * sequence of *steps* — each step emits some private scratch text and/or some
 * tool calls — and drive the REAL agent loop (`createAgentRunner({ model })`)
 * deterministically, with no network and no paid call. Because it tracks the
 * production `LanguageModelV4` interface, it won't drift from a hand-rolled fake.
 *
 * A tool-loop turn is multi-step: the model asks for a tool, the SDK runs that
 * tool's real `execute`, then calls the model again. So a step that calls a tool
 * must be followed by a further step (e.g. a plain `stop`) that ends the turn.
 */

/** One scripted model response (one step of the tool loop). */
export interface ScriptedStep {
  /** Private scratchpad text emitted this step (the model's plain text). */
  text?: string;
  /** Tool calls the model makes this step. */
  toolCalls?: ScriptedToolCall[];
  /**
   * Finish reason for the step. Defaults to `tool-calls` when this step has tool
   * calls (the loop continues) and `stop` otherwise (the turn ends).
   */
  finishReason?: FinishReason;
}

export interface ScriptedToolCall {
  toolName: string;
  /** Tool arguments — serialized to JSON for the provider call. */
  input: unknown;
  toolCallId?: string;
}

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function stepToStream(
  step: ScriptedStep,
  index: number,
): ReadableStream<LanguageModelV4StreamPart> {
  const chunks: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];

  if (step.text) {
    const id = `text-${index}`;
    chunks.push(
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: step.text },
      { type: 'text-end', id },
    );
  }

  const toolCalls = step.toolCalls ?? [];
  toolCalls.forEach((call, i) => {
    chunks.push({
      type: 'tool-call',
      toolCallId: call.toolCallId ?? `call-${index}-${i}`,
      toolName: call.toolName,
      input: JSON.stringify(call.input),
    });
  });

  const unified: FinishReason = step.finishReason ?? (toolCalls.length > 0 ? 'tool-calls' : 'stop');
  chunks.push({ type: 'finish', usage: ZERO_USAGE, finishReason: { unified, raw: undefined } });

  return simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 });
}

/**
 * A mock model that plays back the given steps, one per model call.
 *
 * We drive a function-form `doStream` with our own counter rather than the
 * array form: `MockLanguageModelV4`'s array handling in this SDK build indexes
 * `doStream[doStreamCalls.length]` *after* recording the call, so it skips the
 * first element. A counter is unambiguous and version-proof.
 */
export function scriptModel(steps: ScriptedStep[]): MockLanguageModelV4 {
  let i = 0;
  return new MockLanguageModelV4({
    modelId: 'mock-model',
    doStream: () => {
      const step = steps[i] ?? { finishReason: 'stop' as const }; // defensive: extra call → stop
      const stream = stepToStream(step, i);
      i += 1;
      return Promise.resolve({ stream });
    },
  });
}

/**
 * The common case: the model speaks one bubble via `send_message` and ends.
 * Two steps — the send, then a `stop` once the tool result returns.
 */
export function modelThatSends(...texts: string[]): MockLanguageModelV4 {
  return scriptModel([
    { toolCalls: texts.map((text) => ({ toolName: 'send_message', input: { text } })) },
    { finishReason: 'stop' },
  ]);
}

/** A model that produces only private scratch text and never calls a tool. */
export function modelThatOnlyScratches(text: string): MockLanguageModelV4 {
  return scriptModel([{ text }]);
}

/** A model whose call fails — exercises the loop's error path (5.5). */
export function modelThatThrows(message = 'mock model failure'): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: 'mock-model',
    doStream: () => Promise.reject(new Error(message)),
  });
}

/**
 * A `doGenerate` mock that returns plain text — for the delivery-recovery pass,
 * which uses `generateText` (not streaming) and returns the composed message text.
 * Pass an empty string to model the "nothing to send" case.
 */
export function recoveryText(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: 'mock-recovery',
    doGenerate: () =>
      Promise.resolve({
        content: text ? [{ type: 'text', text }] : [],
        finishReason: { unified: 'stop', raw: undefined },
        usage: ZERO_USAGE,
        warnings: [],
      }),
  });
}

/** A recovery model that must NOT be invoked — fails loudly if a test triggers recovery. */
export function recoveryNotExpected(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: 'mock-recovery',
    doGenerate: () => Promise.reject(new Error('unexpected recovery pass')),
  });
}
