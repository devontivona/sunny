import { describe, expect, it } from 'vitest';
import { rowsOf, sendMessageText, textOfPart } from './data.js';

describe('rowsOf', () => {
  it('returns the rows array of a well-formed driver result', () => {
    const rows = [{ id: '1' }, { id: '2' }];
    expect(rowsOf({ rows })).toBe(rows);
  });

  it('degrades to an empty array when rows is missing, non-array, or the result is not an object', () => {
    expect(rowsOf({})).toEqual([]);
    expect(rowsOf({ rows: null })).toEqual([]);
    expect(rowsOf({ rows: 'oops' })).toEqual([]);
    expect(rowsOf(undefined)).toEqual([]);
    expect(rowsOf('not-an-object')).toEqual([]);
  });
});

describe('textOfPart', () => {
  it('returns the text of a non-empty string text part', () => {
    expect(textOfPart({ type: 'text', text: 'hello' })).toBe('hello');
  });

  it('skips wrong-type, empty, or non-string text parts', () => {
    expect(textOfPart({ type: 'text' })).toBeNull();
    expect(textOfPart({ type: 'text', text: '' })).toBeNull();
    // Legacy/wrong-shape row: text is not a string.
    expect(textOfPart({ type: 'text', text: { nested: 1 } as unknown as string })).toBeNull();
    expect(textOfPart({ type: 'tool-send_message', text: 'x' })).toBeNull();
  });
});

describe('sendMessageText', () => {
  it('returns the text of a send_message tool part', () => {
    expect(sendMessageText({ type: 'tool-send_message', input: { text: 'sent' } })).toBe('sent');
  });

  it('skips non-send parts, missing input, and non-string input text', () => {
    expect(sendMessageText({ type: 'text', input: { text: 'x' } })).toBeNull();
    expect(sendMessageText({ type: 'tool-send_message' })).toBeNull();
    expect(sendMessageText({ type: 'tool-send_message', input: { text: '' } })).toBeNull();
    expect(
      sendMessageText({
        type: 'tool-send_message',
        input: { text: { nested: 1 } as unknown as string },
      }),
    ).toBeNull();
  });
});
