import { describe, expect, it } from 'vitest';
import type { ModelMessage, UIMessage } from 'ai';
import {
  buildTurnRecord,
  classifyDelivery,
  extractScratch,
  extractSends,
  groupSpeakerPrefix,
  rowToUIMessage,
  steerMessageText,
  toModelMessages,
  trimTrailingNonUser,
  usageOf,
} from './turn.js';
import { makeAssistantTurnPayload, makeStoredMessage } from '../../tests/factories.js';

describe('classifyDelivery', () => {
  it('send_message when at least one send happened', () => {
    expect(classifyDelivery(1, '')).toBe('send_message');
    expect(classifyDelivery(3, 'some scratch')).toBe('send_message');
  });

  it('silence when stay_silent was called — even if scratch exists', () => {
    expect(classifyDelivery(0, '', true)).toBe('silence');
    expect(classifyDelivery(0, 'a private note', true)).toBe('silence');
  });

  it('fallback_text (a miss) when scratch exists but neither tool was called', () => {
    expect(classifyDelivery(0, 'private reply leaked into scratch')).toBe('fallback_text');
    expect(classifyDelivery(0, 'private reply', false)).toBe('fallback_text');
  });

  it('silence when nothing was sent, no scratch, no stay_silent', () => {
    expect(classifyDelivery(0, '')).toBe('silence');
  });
});

describe('trimTrailingNonUser', () => {
  const user = (t: string): ModelMessage => ({ role: 'user', content: t });
  const assistant = (t: string): ModelMessage => ({ role: 'assistant', content: t });

  it('drops trailing assistant/tool messages back to the last user message', () => {
    const out = trimTrailingNonUser([user('a'), assistant('b'), user('c'), assistant('d')]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('returns empty when there is no user message', () => {
    expect(trimTrailingNonUser([assistant('only assistant')])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [user('a'), assistant('b')];
    trimTrailingNonUser(input);
    expect(input).toHaveLength(2);
  });
});

describe('extractScratch / extractSends', () => {
  it('extracts joined scratch text and each send_message text from a turn payload', () => {
    const turn = makeAssistantTurnPayload({
      scratch: 'thinking about it',
      sends: ['on it', 'here you go'],
    });
    expect(extractScratch(turn.parts)).toBe('thinking about it');
    expect(extractSends(turn.parts)).toEqual(['on it', 'here you go']);
  });

  it('scratch is empty for a send-only turn; sends is empty for a scratch-only turn', () => {
    expect(extractScratch(makeAssistantTurnPayload({ sends: ['hi'] }).parts)).toBe('');
    expect(extractSends(makeAssistantTurnPayload({ scratch: 'private' }).parts)).toEqual([]);
  });
});

describe('groupSpeakerPrefix', () => {
  it('formats name with an owner tag', () => {
    expect(groupSpeakerPrefix('Devon', true)).toBe('Devon (owner): ');
    expect(groupSpeakerPrefix('Alex', false)).toBe('Alex: ');
  });

  it('is empty when there is no sender name', () => {
    expect(groupSpeakerPrefix(undefined, true)).toBe('');
  });
});

describe('steerMessageText', () => {
  it('prefixes the sender name in a group', () => {
    expect(steerMessageText('hey', 'Alex', true)).toBe('Alex: hey');
  });

  it('passes the text through unchanged in a DM (no prefix)', () => {
    expect(steerMessageText('hey', 'Alex', false)).toBe('hey');
  });

  it('does not prefix when there is no sender name, even in a group', () => {
    expect(steerMessageText('hey', undefined, true)).toBe('hey');
  });

});


describe('usageOf', () => {
  it('flattens AI-SDK usage to the persisted shape, defaulting missing fields to null', () => {
    expect(
      usageOf({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 10 },
      } as Parameters<typeof usageOf>[0]),
    ).toEqual({ in: 100, out: 20, cached: 80, cacheWrite: 10 });
  });

  it('maps absent token counts to null', () => {
    expect(usageOf({} as Parameters<typeof usageOf>[0])).toEqual({
      in: null,
      out: null,
      cached: null,
      cacheWrite: null,
    });
  });
});

describe('buildTurnRecord', () => {
  it('stamps D-MG9 metadata onto the assembled assistant message', () => {
    const assistant = makeAssistantTurnPayload({ scratch: 'note', sends: ['hi'] }) as UIMessage;
    const record = buildTurnRecord(assistant, assistant.parts, {
      model: 'claude-opus-4-8',
      usage: { in: 1, out: 2, cached: 3, cacheWrite: 4 },
      delivered: 'send_message',
      recovered: false,
      steps: 2,
      createdAt: '2026-06-27T00:00:00.000Z',
    });
    expect(record.parts).toBe(assistant.parts);
    expect(record.metadata).toMatchObject({
      model: 'claude-opus-4-8',
      delivered: 'send_message',
      recovered: false,
      steps: 2,
      createdAt: '2026-06-27T00:00:00.000Z',
      usage: { in: 1, out: 2, cached: 3, cacheWrite: 4 },
    });
  });

  it('preserves existing metadata on the assistant message', () => {
    const assistant = {
      ...(makeAssistantTurnPayload({ sends: ['hi'] }) as UIMessage),
      metadata: { id: 'abc' },
    };
    const record = buildTurnRecord(assistant, assistant.parts, {
      model: 'm',
      usage: { in: null, out: null, cached: null, cacheWrite: null },
      delivered: 'silence',
      recovered: true,
      steps: 0,
    });
    expect((record.metadata as Record<string, unknown>).id).toBe('abc');
    expect((record.metadata as Record<string, unknown>).recovered).toBe(true);
  });
});

describe('toModelMessages — strips reasoning (extended-thinking) parts from history', () => {
  it('drops reasoning/step-start so prior turns are not re-sent with thinking blocks', async () => {
    const payload = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'reasoning', text: 'PRIVATE THINKING that must not be replayed' },
        { type: 'text', text: 'scratch note' },
        {
          type: 'tool-send_message',
          toolCallId: 's1',
          state: 'output-available',
          input: { text: 'hello there' },
          output: 'delivered',
        },
      ],
    };
    const row = makeStoredMessage({ role: 'assistant', text: 'hello there', payload });
    const json = JSON.stringify(await toModelMessages([row], false));
    expect(json).not.toContain('PRIVATE THINKING');
    expect(json).not.toContain('reasoning');
    expect(json).toContain('hello there'); // the send_message tool call survives
  });
});

describe('renderTranslatorParts — read-time rendering of relayed progress updates', () => {
  const payload = {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'working notes' },
      {
        type: 'tool-bash',
        toolCallId: 'b1',
        state: 'output-available',
        input: { command: 'ls' },
        output: 'ok',
      },
      { type: 'data-translator', data: { text: 'on it — checking now', step: 1 } },
      { type: 'text', text: 'here is the answer' },
    ],
  };

  it('attributed (default): renders each update as a bracketed text line naming the subject', async () => {
    const row = makeStoredMessage({ role: 'assistant', text: 'here is the answer', payload });
    const json = JSON.stringify(
      await toModelMessages([row], false, { translatorHistory: 'attributed', translatorSubject: 'Devon' }),
    );
    expect(json).toContain('progress update relayed to Devon');
    expect(json).toContain('on it — checking now');
    expect(json).not.toContain('data-translator');
  });

  it('excluded: strips the updates entirely (the A/B arm)', async () => {
    const row = makeStoredMessage({ role: 'assistant', text: 'here is the answer', payload });
    const json = JSON.stringify(
      await toModelMessages([row], false, { translatorHistory: 'excluded', translatorSubject: 'Devon' }),
    );
    expect(json).not.toContain('on it — checking now');
    expect(json).not.toContain('progress update relayed');
    expect(json).toContain('here is the answer'); // the rest of the turn survives
  });

  it('defaults to attributed with a generic subject when no options are passed', async () => {
    const row = makeStoredMessage({ role: 'assistant', text: 'here is the answer', payload });
    const json = JSON.stringify(await toModelMessages([row], false));
    expect(json).toContain('progress update relayed to the user');
  });
});

describe('rowToUIMessage — legacy (pre-D-MG9, no payload) reconstruction', () => {
  it('reconstructs a legacy user row as a single text part', () => {
    const row = makeStoredMessage({ role: 'user', text: 'hello', payload: null });
    const msg = rowToUIMessage(row, false) as UIMessage;
    expect(msg.role).toBe('user');
    expect(msg.parts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('prefixes the group speaker on a legacy user row', () => {
    const row = makeStoredMessage({
      role: 'user',
      text: 'hello',
      senderName: 'Alex',
      isOwner: false,
      payload: null,
    });
    const msg = rowToUIMessage(row, true) as UIMessage;
    expect(msg.parts).toEqual([{ type: 'text', text: 'Alex: hello' }]);
  });

  it('reconstructs a legacy assistant row as plain assistant text', () => {
    const row = makeStoredMessage({ role: 'assistant', text: 'prior reply', payload: null });
    const msg = rowToUIMessage(row, false) as UIMessage;
    expect(msg.role).toBe('assistant');
    expect(msg.parts).toEqual([{ type: 'text', text: 'prior reply' }]);
  });

  it('passes a D-MG9 payload row through untouched in a DM', () => {
    const payload = makeAssistantTurnPayload({ sends: ['hi'] });
    const row = makeStoredMessage({ role: 'assistant', text: 'hi', payload });
    expect(rowToUIMessage(row, false)).toBe(payload);
  });
});
