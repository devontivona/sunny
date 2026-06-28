import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';

/**
 * Deterministic mock turn model for the `@workflow/vitest` workflow suite + the loopback
 * test channel (AI SDK v7 / `WorkflowAgent`). Replaces `@workflow/ai/test`'s
 * `mockSequenceModel`, which has no `@ai-sdk/workflow` equivalent.
 *
 * WHY a custom class and not `MockLanguageModelV4` directly: `WorkflowAgent` passes the model
 * to its journaled `doStreamStep` as a STEP ARGUMENT, so the model must be serializable across
 * the step boundary. Real providers (`@ai-sdk/anthropic`) implement the WDK class-serialization
 * protocol (`WORKFLOW_SERIALIZE`/`WORKFLOW_DESERIALIZE` from `@workflow/serde`); `MockLanguageModelV4`
 * is a plain test util holding closures, so passing it fails with "Failed to serialize step
 * arguments". This wrapper holds only the plain `responses` data, delegates the model interface
 * to an inner `MockLanguageModelV4`, and implements the serde protocol so it round-trips: the
 * serializer stores `{ responses }` and reconstructs the inner mock inside the step on every replay.
 */

export type MockResponseDescriptor =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; input: string };

/** Build the inner `MockLanguageModelV4` (separate fn so the `new` is not a step closure local —
 *  SWC plugin workaround, vercel/workflow#1365). Picks the response by assistant-message count. */
function buildInner(responses: MockResponseDescriptor[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: 'mock-model',
    doStream: async (options: { prompt: Array<{ role: string }> }) => {
      const idx = Math.min(
        options.prompt.filter((m) => m.role === 'assistant').length,
        responses.length - 1,
      );
      const r = responses[idx] ?? { type: 'text', text: '' };
      const meta = { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date() };
      const usage = {
        inputTokens: { total: 5, noCache: 5 },
        outputTokens: { total: 10, text: 10 },
      };
      const parts =
        r.type === 'text'
          ? [
              { type: 'stream-start', warnings: [] },
              meta,
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: r.text },
              { type: 'text-end', id: '1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              meta,
              {
                type: 'tool-call',
                toolCallId: `call-${idx + 1}`,
                toolName: r.toolName,
                input: r.input,
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
            ];
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(c) {
            for (const p of parts as unknown as LanguageModelV4StreamPart[]) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  });
}

export class SerializableMockModel {
  readonly specificationVersion = 'v4' as const;
  private readonly inner: MockLanguageModelV4;

  constructor(public readonly responses: MockResponseDescriptor[]) {
    this.inner = buildInner(responses);
  }

  get provider(): string {
    return this.inner.provider;
  }
  get modelId(): string {
    return this.inner.modelId;
  }
  get supportedUrls(): LanguageModelV4['supportedUrls'] {
    return this.inner.supportedUrls as LanguageModelV4['supportedUrls'];
  }
  doGenerate(options: Parameters<MockLanguageModelV4['doGenerate']>[0]) {
    return this.inner.doGenerate(options);
  }
  doStream(options: Parameters<MockLanguageModelV4['doStream']>[0]) {
    return this.inner.doStream(options);
  }

  static [WORKFLOW_SERIALIZE](model: SerializableMockModel): {
    responses: MockResponseDescriptor[];
  } {
    return { responses: model.responses };
  }
  static [WORKFLOW_DESERIALIZE](data: {
    responses: MockResponseDescriptor[];
  }): SerializableMockModel {
    return new SerializableMockModel(data.responses);
  }
}

// NOTE: no manual `registerSerializationClass` — the WDK SWC plugin AUTO-registers any class
// carrying the serde protocol (`WORKFLOW_SERIALIZE`/`WORKFLOW_DESERIALIZE`) in compiled
// workflow/step bundles (it inlines an equivalent registration IIFE), which is the context where
// this model crosses the journaled `doStreamStep` boundary. A manual call here collides with that
// (re-defining the non-configurable `classId` throws "Cannot redefine property: classId").

/** A mock turn model that plays through `responses`, one per model step. */
export function mockSequenceModel(responses: MockResponseDescriptor[]): SerializableMockModel {
  return new SerializableMockModel(responses);
}
