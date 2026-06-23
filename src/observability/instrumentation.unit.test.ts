import { describe, expect, it } from 'vitest';
import type { ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import type { AttributeValue } from '@opentelemetry/api';
import { RedactingSpanProcessor } from './instrumentation.js';
import { createRedactor } from './redact.js';

// A redactor that scrubs one known literal plus the default credential patterns.
const redactor = createRedactor({ secrets: ['hunter2-secret'] });
const processor = new RedactingSpanProcessor(redactor);

function fakeReadable(attributes: Record<string, AttributeValue>): ReadableSpan {
  return { attributes } as unknown as ReadableSpan;
}

/** A writable-span stub exposing the bits onEnding touches. */
function fakeWritable(attributes: Record<string, AttributeValue>) {
  return {
    attributes,
    setAttribute(key: string, value: AttributeValue) {
      attributes[key] = value;
      return this;
    },
  } as unknown as Span & { attributes: Record<string, AttributeValue> };
}

describe('RedactingSpanProcessor.onEnd', () => {
  it('redacts secrets in raw AI SDK string attributes (the path mask misses)', () => {
    const attrs: Record<string, AttributeValue> = {
      'ai.prompt': 'keep this safe: sk-ant-AbC123_def456 and hunter2-secret',
      'ai.response.text': 'ok',
      'gen_ai.usage.input_tokens': 42,
    };
    processor.onEnd(fakeReadable(attrs));
    expect(attrs['ai.prompt']).toBe('keep this safe: [REDACTED] and [REDACTED]');
    expect(attrs['ai.response.text']).toBe('ok');
    expect(attrs['gen_ai.usage.input_tokens']).toBe(42); // numbers untouched
  });

  it('redacts secrets inside string-array attributes', () => {
    const attrs: Record<string, AttributeValue> = {
      'ai.prompt.messages': ['hello', 'token sk-ant-ZZZ999aaa'],
    };
    processor.onEnd(fakeReadable(attrs));
    expect(attrs['ai.prompt.messages']).toEqual(['hello', 'token [REDACTED]']);
  });

  it('leaves clean attributes untouched', () => {
    const attrs: Record<string, AttributeValue> = { 'ai.model.id': 'claude-opus-4-8' };
    processor.onEnd(fakeReadable(attrs));
    expect(attrs['ai.model.id']).toBe('claude-opus-4-8');
  });
});

describe('RedactingSpanProcessor.onEnding', () => {
  it('rewrites secrets via setAttribute while the span is still writable', () => {
    const span = fakeWritable({ 'ai.prompt': 'pw=hunter2-secret' });
    processor.onEnding(span);
    expect(span.attributes['ai.prompt']).toBe('pw=[REDACTED]');
  });
});
