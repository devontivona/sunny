import { describe, expect, it } from 'vitest';
import type { ModelMessage, UIMessage } from 'ai';
import {
  classifyDelivery,
  extractScratch,
  extractSends,
  groupSpeakerPrefix,
  rowToUIMessage,
  trimTrailingNonUser,
} from './turn.js';
import { makeAssistantTurnPayload, makeStoredMessage } from '../../tests/factories.js';

describe('classifyDelivery', () => {
  it('send_message when at least one send happened', () => {
    expect(classifyDelivery(1, '')).toBe('send_message');
    expect(classifyDelivery(3, 'some scratch')).toBe('send_message');
  });

  it('fallback_text when nothing was sent but scratch exists', () => {
    expect(classifyDelivery(0, 'private reply leaked into scratch')).toBe('fallback_text');
  });

  it('silence when nothing was sent and there is no scratch', () => {
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
