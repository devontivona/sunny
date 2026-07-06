import { describe, expect, it } from 'vitest';
import { TracePromotingSpanProcessor } from './tracePromotion.js';

/** Minimal fake of an OTel writable `Span` for the `onEnding` path. */
function fakeSpan(attributes: Record<string, unknown>) {
  return {
    attributes,
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
    },
  };
}

describe('TracePromotingSpanProcessor', () => {
  const proc = new TracePromotingSpanProcessor();

  it('promotes AI-SDK telemetry to Langfuse trace-level attributes', () => {
    const attrs: Record<string, unknown> = {
      'ai.telemetry.functionId': 'agent-turn',
      'ai.telemetry.metadata.langfuseSessionId': 'sendblue:owner:contact',
      'ai.telemetry.metadata.langfuseUserId': 'Devon',
      'ai.prompt.messages': '[...]',
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.name']).toBe('agent-turn');
    expect(attrs['langfuse.session.id']).toBe('sendblue:owner:contact');
    expect(attrs['langfuse.user.id']).toBe('Devon');
  });

  it('promotes from AI SDK v7 attribute names (gen_ai.agent.name + ai.settings.context.*)', () => {
    // v7 (`@ai-sdk/otel`) renamed the source attrs; confirmed live against Langfuse (task 4.2).
    const attrs: Record<string, unknown> = {
      'gen_ai.agent.name': 'agent-turn',
      'ai.settings.context.langfuseSessionId': 'sendblue:owner:contact',
      'ai.settings.context.langfuseUserId': 'Devon',
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.name']).toBe('agent-turn');
    expect(attrs['langfuse.session.id']).toBe('sendblue:owner:contact');
    expect(attrs['langfuse.user.id']).toBe('Devon');
  });

  it('uses the per-run functionId as the trace name (turns vs jobs distinguishable)', () => {
    const job: Record<string, unknown> = {
      'ai.telemetry.functionId': 'background-job',
      'ai.telemetry.metadata.langfuseSessionId': 'thread-1',
    };
    proc.onEnding(fakeSpan(job) as never);
    expect(job['langfuse.trace.name']).toBe('background-job');
    expect(job['langfuse.session.id']).toBe('thread-1');
  });

  it('is a no-op on spans without our AI-SDK session metadata (WDK infra, etc.)', () => {
    const attrs: Record<string, unknown> = { 'some.other.attr': 'x' };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.name']).toBeUndefined();
    expect(attrs['langfuse.session.id']).toBeUndefined();
  });

  it('does not overwrite trace attributes that are already set', () => {
    const attrs: Record<string, unknown> = {
      'ai.telemetry.functionId': 'agent-turn',
      'ai.telemetry.metadata.langfuseSessionId': 'thread-1',
      'langfuse.trace.name': 'preset',
      'langfuse.session.id': 'preset-session',
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.name']).toBe('preset');
    expect(attrs['langfuse.session.id']).toBe('preset-session');
  });

  it('onEnd mutates attributes in place (fallback path)', () => {
    const attrs: Record<string, unknown> = {
      'ai.telemetry.functionId': 'agent-turn',
      'ai.telemetry.metadata.langfuseSessionId': 'thread-2',
    };
    proc.onEnd({ attributes: attrs } as never);
    expect(attrs['langfuse.trace.name']).toBe('agent-turn');
    expect(attrs['langfuse.session.id']).toBe('thread-2');
  });

  it('does NOT name the trace from the delivery-recovery checkpoint (it runs within a turn)', () => {
    const attrs: Record<string, unknown> = {
      'ai.telemetry.functionId': 'delivery-recovery',
      'ai.telemetry.metadata.langfuseSessionId': 'thread-2',
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.name']).toBeUndefined(); // agent-turn span names the trace
    expect(attrs['langfuse.session.id']).toBe('thread-2'); // session still promotes
  });

  it('promotes the last user message as trace input', () => {
    const attrs: Record<string, unknown> = {
      'ai.telemetry.metadata.langfuseSessionId': 'thread-1',
      'ai.prompt.messages': JSON.stringify([
        { role: 'system', content: 'you are sunny' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: 'what is a DE1?' }] },
      ]),
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.input']).toBe('what is a DE1?');
  });

  it('uses send_message text for trace output and IGNORES plain model text (scratch, D-MG8)', () => {
    const attrs: Record<string, unknown> = {
      'ai.telemetry.functionId': 'agent-turn',
      'ai.telemetry.metadata.langfuseSessionId': 'thread-1',
      'ai.response.text': 'internal scratch — the user asked X so I will...', // NOT delivered
      'ai.response.toolCalls': JSON.stringify([
        { toolName: 'stay_silent', input: '{}' },
        { toolName: 'send_message', input: JSON.stringify({ text: 'on it ✅' }) },
      ]),
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.output']).toBe('on it ✅'); // the delivered reply, not the scratch
  });

  it('uses the model text for trace output on the delivery-recovery checkpoint', () => {
    const attrs: Record<string, unknown> = {
      'ai.telemetry.functionId': 'delivery-recovery',
      'ai.telemetry.metadata.langfuseSessionId': 'thread-1',
      'ai.response.text': 'acknowledged', // recovery generates the reply AS text
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.output']).toBe('acknowledged');
  });

  it('does NOT set output from a turn span that only has scratch text (no send_message)', () => {
    const attrs: Record<string, unknown> = {
      'ai.telemetry.functionId': 'agent-turn',
      'ai.telemetry.metadata.langfuseSessionId': 'thread-1',
      'ai.response.text': 'thinking out loud, not delivered',
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.output']).toBeUndefined();
  });

  it('uses the FINAL step model text as trace output (text-as-reply, finish=stop)', () => {
    // PR #31: the reply IS the final text; the final step finishes `stop`, tool steps
    // finish `tool-calls` (previous test) and never claim the output.
    const attrs: Record<string, unknown> = {
      'gen_ai.agent.name': 'agent-turn',
      'ai.settings.context.langfuseSessionId': 'thread-1',
      'ai.response.text': 'Done — deployed and verified.',
      'gen_ai.response.finish_reasons': ['stop'],
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.output']).toBe('Done — deployed and verified.');
  });

  it('does NOT name the trace or claim input/output from the progress-translator', () => {
    // The translator runs WITHIN a turn (a `'use step'` → its spans join the turn's trace);
    // before the aux skip-list it renamed real turn traces to "progress-translator".
    const attrs: Record<string, unknown> = {
      'gen_ai.agent.name': 'progress-translator',
      'ai.settings.context.langfuseSessionId': 'thread-1',
      'ai.prompt.messages': JSON.stringify([{ role: 'user', content: 'interim notes' }]),
      'ai.response.text': 'quick progress update',
      'gen_ai.response.finish_reasons': ['stop'],
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.name']).toBeUndefined();
    expect(attrs['langfuse.trace.input']).toBeUndefined();
    expect(attrs['langfuse.trace.output']).toBeUndefined();
    expect(attrs['langfuse.session.id']).toBe('thread-1'); // session still promotes
  });

  it('turn-backstop (renamed delivery-recovery) claims output but not name/input', () => {
    const attrs: Record<string, unknown> = {
      'gen_ai.agent.name': 'turn-backstop',
      'ai.settings.context.langfuseSessionId': 'thread-1',
      'ai.prompt.messages': JSON.stringify([{ role: 'user', content: 'notes' }]),
      'ai.response.text': 'Still working on it — the build is at step 3.',
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.name']).toBeUndefined();
    expect(attrs['langfuse.trace.input']).toBeUndefined();
    expect(attrs['langfuse.trace.output']).toBe('Still working on it — the build is at step 3.');
  });

  it('reads semconv gen_ai.input/output.messages (the v7 integration dialect)', () => {
    const attrs: Record<string, unknown> = {
      'gen_ai.agent.name': 'turn-backstop',
      'ai.settings.context.langfuseSessionId': 'thread-1',
      'gen_ai.output.messages': JSON.stringify([
        {
          role: 'assistant',
          parts: [{ type: 'text', content: 'composed status' }],
          finish_reason: 'stop',
        },
      ]),
    };
    proc.onEnding(fakeSpan(attrs) as never);
    expect(attrs['langfuse.trace.output']).toBe('composed status');

    const input: Record<string, unknown> = {
      'gen_ai.agent.name': 'agent-turn',
      'ai.settings.context.langfuseSessionId': 'thread-1',
      'gen_ai.input.messages': JSON.stringify([
        { role: 'user', parts: [{ type: 'text', content: 'hello there' }] },
      ]),
    };
    proc.onEnding(fakeSpan(input) as never);
    expect(input['langfuse.trace.input']).toBe('hello there');
  });
});
