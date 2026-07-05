import { describe, expect, it } from 'vitest';
import type { ModelMessage, UIMessage } from 'ai';
import {
  assistantUIMessageFromResponse,
  calledStaySilent,
  classifyTextDelivery,
  extractFinalText,
  extractInterimText,
  extractTranslatorUpdates,
  splitBubbles,
  stripNoReply,
  translatorPart,
} from './delivery.js';
import { makeAssistantTurnPayload } from '../../tests/factories.js';

type Part = UIMessage['parts'][number];
const text = (t: string): Part => ({ type: 'text', text: t }) as Part;
const tool = (name: string, id: string): Part =>
  ({ type: `tool-${name}`, toolCallId: id, state: 'output-available', input: {} }) as Part;

describe('text-as-reply extraction (text delivery mode)', () => {
  it('splits final (after the last tool part) from interim (at/before it)', () => {
    const parts = [text('checking...'), tool('bash', 'a'), text('found it'), tool('bash', 'b'), text('here is the answer')];
    expect(extractFinalText(parts)).toBe('here is the answer');
    expect(extractInterimText(parts)).toBe('checking...\nfound it');
  });

  it('a turn with no tool parts is all final', () => {
    const parts = [text('just a reply')];
    expect(extractFinalText(parts)).toBe('just a reply');
    expect(extractInterimText(parts)).toBe('');
  });

  it('data-translator parts never shift the final/interim boundary', () => {
    const parts = [text('working'), tool('bash', 'a'), translatorPart('on it!', 1), text('the answer')];
    expect(extractFinalText(parts)).toBe('the answer');
    expect(extractInterimText(parts)).toBe('working');
  });

  it('classifies: final text → text; silence signaled → silence; interim only → fallback; nothing → silence', () => {
    expect(classifyTextDelivery('answer', '', false)).toBe('text');
    expect(classifyTextDelivery('', '', true)).toBe('silence');
    expect(classifyTextDelivery('', 'notes only', false)).toBe('fallback_text');
    expect(classifyTextDelivery('', '', false)).toBe('silence');
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
    const parts = [translatorPart('on it — checking flights', 1), translatorPart('narrowing options', 4)];
    expect(extractTranslatorUpdates(parts)).toEqual([
      { text: 'on it — checking flights', step: 1 },
      { text: 'narrowing options', step: 4 },
    ]);
  });

  it('splitBubbles: blank-line paragraphs become separate bubbles', () => {
    expect(splitBubbles('first bubble\n\nsecond bubble\nsame bubble')).toEqual([
      'first bubble',
      'second bubble\nsame bubble',
    ]);
    expect(splitBubbles('  \n \n')).toEqual([]);
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
