import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { ObservedLanguageModel } from './observedModel.js';

// The WDK serde symbols, read OFF THE CLASS — deliberately NOT via the serde package, and
// deliberately NOT bound to the upstream constant names. The WDK builders' discovery sweep
// scans EVERY repo source file for workflow content patterns (a serde-package import, the
// serde Symbol.for descriptions, or bracket access with the upstream constant names —
// `transform-utils.js` in `@workflow/builders`); a match pulls this TEST into the workflow VM
// bundle (vitest → chai) and breaks every durable run with "EventTarget is not defined".
const classSymbol = (description: string): symbol => {
  const sym = Object.getOwnPropertySymbols(ObservedLanguageModel).find(
    (s) => s.description === description,
  );
  if (!sym) throw new Error(`ObservedLanguageModel is missing Symbol(${description})`);
  return sym;
};
const serializeSym = classSymbol('workflow' + '-serialize');
const deserializeSym = classSymbol('workflow' + '-deserialize');

// Real in-memory OTel pipeline: the wrapper resolves its tracer from the global API registry
// (that is the production mechanism — host step bundles share `globalThis`), so the test
// registers a provider globally and disables it after.
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);
afterAll(() => trace.disable());

/** Minimal v4 model streaming the given parts (or failing), enough for the wrapper's seams. */
function fakeModel(parts: LanguageModelV4StreamPart[], opts?: { failStream?: boolean }) {
  return {
    specificationVersion: 'v4' as const,
    provider: 'anthropic.messages',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: async () => ({ generated: true }) as never,
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(c) {
          for (const p of parts) c.enqueue(p);
          if (opts?.failStream) c.error(new Error('stream broke'));
          else c.close();
        },
      }),
    }),
  } as unknown as LanguageModelV4;
}

const usage = {
  inputTokens: { total: 7, noCache: 7, cacheRead: 2, cacheWrite: 1 },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
} as never;

const finishPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
} as unknown as LanguageModelV4StreamPart;

async function drain(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const out: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe('ObservedLanguageModel', () => {
  beforeEach(() => exporter.reset());

  const meta = { functionId: 'agent-turn', sessionId: 'thread-1' };

  it('emits ONE generation span per doStream with prompt/response/usage attributes', async () => {
    const model = new ObservedLanguageModel(
      fakeModel([
        { type: 'text-delta', id: '1', delta: 'hel' } as never,
        { type: 'text-delta', id: '1', delta: 'lo' } as never,
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'bash',
          input: '{"command":"ls"}',
        } as never,
        finishPart,
      ]),
      meta,
    );
    const prompt = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never;
    const result = await model.doStream({ prompt } as never);
    const parts = await drain(result.stream);
    expect(parts).toHaveLength(4); // pass-through unchanged

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('chat fake-model');
    expect(span.attributes['langfuse.observation.type']).toBe('generation');
    expect(span.attributes['gen_ai.provider.name']).toBe('anthropic');
    expect(span.attributes['gen_ai.agent.name']).toBe('agent-turn');
    expect(span.attributes['ai.settings.context.langfuseSessionId']).toBe('thread-1');
    expect(span.attributes['ai.prompt.messages']).toBe(JSON.stringify(prompt));
    expect(span.attributes['langfuse.observation.input']).toBe(JSON.stringify(prompt));
    expect(span.attributes['ai.response.text']).toBe('hello');
    expect(span.attributes['ai.response.toolCalls']).toContain('"toolName":"bash"');
    expect(span.attributes['langfuse.observation.output']).toContain('hello');
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(7);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(3);
    expect(span.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(2);
    expect(span.attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('ends the span with ERROR status when the stream fails (no leaked open span)', async () => {
    const model = new ObservedLanguageModel(
      fakeModel([{ type: 'text-delta', id: '1', delta: 'par' } as never], { failStream: true }),
      meta,
    );
    const result = await model.doStream({ prompt: [] } as never);
    await expect(drain(result.stream)).rejects.toThrow('stream broke');
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('ends the span with ERROR when doStream itself rejects', async () => {
    const inner = fakeModel([]);
    (inner as { doStream: unknown }).doStream = async () => {
      throw new Error('api down');
    };
    const model = new ObservedLanguageModel(inner, meta);
    await expect(model.doStream({ prompt: [] } as never)).rejects.toThrow('api down');
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(2);
  });

  it('round-trips through the WDK class-serialization protocol', () => {
    const statics = ObservedLanguageModel as unknown as Record<
      symbol,
      (arg: unknown) => ObservedLanguageModel
    >;
    const inner = fakeModel([]);
    const model = new ObservedLanguageModel(inner, meta);
    const data = statics[serializeSym]!(model);
    expect(data).toEqual({ inner, meta });
    const revived = statics[deserializeSym]!(data);
    expect(revived).toBeInstanceOf(ObservedLanguageModel);
    expect(revived.modelId).toBe('fake-model');
    expect(revived.meta).toEqual(meta);
  });

  it('delegates doGenerate untraced (host-side vanilla callers own their telemetry)', async () => {
    const model = new ObservedLanguageModel(fakeModel([]), meta);
    await model.doGenerate({ prompt: [] } as never);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
