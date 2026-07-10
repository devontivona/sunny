import { describe, expect, it } from 'vitest';
import type { ModelMessage, UIMessage } from 'ai';
import {
  assistantUIMessageFromResponse,
  calledStaySilent,
  classifyTextDelivery,
  extractFinalText,
  extractInterimText,
  extractReportBlocks,
  extractToolResultText,
  extractTranslatorUpdates,
  stripBinaryRuns,
  stripNoReply,
  stripNoReport,
  translatorPart,
} from './delivery.js';
import { makeAssistantTurnPayload } from '../../tests/factories.js';

type Part = UIMessage['parts'][number];
const text = (t: string): Part => ({ type: 'text', text: t }) as Part;
const tool = (name: string, id: string): Part =>
  ({ type: `tool-${name}`, toolCallId: id, state: 'output-available', input: {} }) as Part;

describe('text-as-reply extraction (text delivery mode)', () => {
  it('splits final (after the last tool part) from interim (at/before it)', () => {
    const parts = [
      text('checking...'),
      tool('bash', 'a'),
      text('found it'),
      tool('bash', 'b'),
      text('here is the answer'),
    ];
    expect(extractFinalText(parts)).toBe('here is the answer');
    expect(extractInterimText(parts)).toBe('checking...\nfound it');
  });

  it('a turn with no tool parts is all final', () => {
    const parts = [text('just a reply')];
    expect(extractFinalText(parts)).toBe('just a reply');
    expect(extractInterimText(parts)).toBe('');
  });

  it('data-translator parts never shift the final/interim boundary', () => {
    const parts = [
      text('working'),
      tool('bash', 'a'),
      translatorPart('on it!', 1),
      text('the answer'),
    ];
    expect(extractFinalText(parts)).toBe('the answer');
    expect(extractInterimText(parts)).toBe('working');
  });

  it('classifies: final text → text; silence signaled → silence; interim only → fallback; nothing → silence', () => {
    expect(classifyTextDelivery('answer', '', false)).toBe('text');
    expect(classifyTextDelivery('', '', true)).toBe('silence');
    expect(classifyTextDelivery('', 'notes only', false)).toBe('fallback_text');
    expect(classifyTextDelivery('', '', false)).toBe('silence');
  });

  it('R9a: abnormal finish with tool activity but no text is NOT deliberate silence', () => {
    // A thinking turn can do real tool work yet write no delivered text: reasoning parts are
    // dropped and tool-call parts don't count as interim, so both final AND interim are empty.
    // When the turn ended ABNORMALLY (step-limit / length / error) that must route to the
    // backstop (fallback_text), not be swallowed as a deliberate no-reply.
    const parts = [tool('bash', 'a')];
    const final = extractFinalText(parts); // '' (nothing after the tool call)
    const interim = extractInterimText(parts); // '' (tool-call parts are not interim text)
    expect(final).toBe('');
    expect(interim).toBe('');

    // Abnormal finishes route to the backstop even with nothing delivered.
    expect(classifyTextDelivery(final, interim, false, 'tool-calls')).toBe('fallback_text');
    expect(classifyTextDelivery(final, interim, false, 'length')).toBe('fallback_text');
    expect(classifyTextDelivery(final, interim, false, 'error')).toBe('fallback_text');

    // A NORMAL stop with nothing delivered is still deliberate silence; and omitting the
    // finish reason preserves the legacy default (silence).
    expect(classifyTextDelivery(final, interim, false, 'stop')).toBe('silence');
    expect(classifyTextDelivery(final, interim, false)).toBe('silence');
  });

  it('stripNoReply: a sentinel-only reply is silence; nothing else is touched', () => {
    expect(stripNoReply('<no-reply/>')).toEqual({ text: '', sentinel: true });
    expect(stripNoReply('  <no-reply/>  ')).toEqual({ text: '', sentinel: true });
    expect(stripNoReply('here is your answer')).toEqual({
      text: 'here is your answer',
      sentinel: false,
    });
  });

  it('stripNoReply: real content alongside a stray sentinel is DELIVERED, token stripped', () => {
    // Nothing genuinely written for the user is ever swallowed — the safety property
    // the terminal-stay_silent design lacked.
    const parsed = stripNoReply('<no-reply/> actually — take the earlier flight.');
    expect(parsed).toEqual({ text: 'actually — take the earlier flight.', sentinel: true });
    expect(classifyTextDelivery(parsed.text, '', parsed.sentinel)).toBe('text');
  });

  it('final text WINS over a legacy stay_silent tool part (the spam pathology, replayed rows)', () => {
    // Tool-mode-era rows can carry stay_silent parts; a real reply after one must
    // still classify as delivered, never swallowed as silence.
    const parts = [tool('stay_silent', 's1'), text('actually, here is your answer')];
    const final = extractFinalText(parts);
    expect(final).toBe('actually, here is your answer');
    expect(classifyTextDelivery(final, extractInterimText(parts), calledStaySilent(parts))).toBe(
      'text',
    );
  });

  it('round-trips translator updates through data-translator parts', () => {
    const parts = [
      translatorPart('on it — checking flights', 1),
      translatorPart('narrowing options', 4),
    ];
    expect(extractTranslatorUpdates(parts)).toEqual([
      { text: 'on it — checking flights', step: 1 },
      { text: 'narrowing options', step: 4 },
    ]);
  });

  it('stripNoReport: the child sentinel mirrors stripNoReply mechanics', () => {
    expect(stripNoReport('<no-report/>')).toEqual({ text: '', sentinel: true });
    expect(stripNoReport('<no-report/> but actually: found it')).toEqual({
      text: 'but actually: found it',
      sentinel: true,
    });
    expect(stripNoReport('normal report')).toEqual({ text: 'normal report', sentinel: false });
    // The two sentinels are distinct: one never triggers the other.
    expect(stripNoReport('<no-reply/>')).toEqual({ text: '<no-reply/>', sentinel: false });
  });

  it('extractReportBlocks: zero, one, and many complete blocks', () => {
    expect(extractReportBlocks('no blocks here')).toEqual({ reports: [], rest: 'no blocks here' });
    expect(extractReportBlocks('pre <report>update one</report> post')).toEqual({
      reports: ['update one'],
      rest: 'pre  post',
    });
    const many = extractReportBlocks(
      '<report>first</report>\nworking...\n<report>second\nspans lines</report>\ndone',
    );
    expect(many.reports).toEqual(['first', 'second\nspans lines']);
    expect(many.rest).toBe('working...\n\ndone');
  });

  it('extractReportBlocks: an unterminated block is left as plain text, never partially delivered', () => {
    const out = extractReportBlocks('working\n<report>half-written and cut off');
    expect(out.reports).toEqual([]);
    expect(out.rest).toContain('<report>half-written and cut off');
  });

  it('extractReportBlocks: an empty block delivers nothing', () => {
    expect(extractReportBlocks('<report>  </report>rest')).toEqual({ reports: [], rest: 'rest' });
  });
});

describe('extractToolResultText — projection v2 (context-lifecycle)', () => {
  const toolResult = (toolName: string, output: unknown): ModelMessage =>
    ({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', toolName, output }],
    }) as unknown as ModelMessage;

  it('extracts each tool result labeled by tool name', () => {
    const out = extractToolResultText([
      toolResult('bash', { type: 'text', value: 'total due: $412.50' }),
      toolResult('recall_history', { type: 'json', value: { hits: 2 } }),
    ]);
    expect(out).toContain('[bash] total due: $412.50');
    expect(out).toContain('[recall_history] {"hits":2}');
  });

  it('ignores non-tool messages and empty outputs', () => {
    const out = extractToolResultText([
      { role: 'assistant', content: [{ type: 'text', text: 'narration' }] } as ModelMessage,
      toolResult('bash', { type: 'text', value: '   ' }),
    ]);
    expect(out).toBe('');
  });

  it('caps each result and the row total', () => {
    const big = 'x'.repeat(10_000);
    const out = extractToolResultText(
      [
        toolResult('bash', { type: 'text', value: big }),
        toolResult('bash', { type: 'text', value: big }),
      ],
      { perResultChars: 100, perRowChars: 150 },
    );
    // First result clipped to ~100 chars; the second would exceed the row cap and is dropped.
    expect(out.length).toBeLessThanOrEqual(150);
    expect(out.startsWith('[bash] ')).toBe(true);
  });

  it('strips data-URLs and long base64 runs (binary never enters the projection)', () => {
    const b64 = Buffer.from('a'.repeat(400)).toString('base64');
    expect(stripBinaryRuns(`before data:image/png;base64,${b64} after`)).toBe(
      'before [data-url stripped] after',
    );
    expect(stripBinaryRuns(`raw ${b64} tail`)).toBe('raw [binary stripped] tail');
    expect(stripBinaryRuns('a normal sentence stays')).toBe('a normal sentence stays');
  });
});

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
