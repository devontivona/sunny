import { describe, expect, it } from 'vitest';
import { isGroupThreadId } from './threadId.js';

describe('isGroupThreadId', () => {
  it('treats `sendblue:<from>:g:<id>` as a group', () => {
    expect(isGroupThreadId('sendblue:owner:g:group1')).toBe(true);
  });

  it('treats a DM thread id as not a group', () => {
    expect(isGroupThreadId('sendblue:owner:contact')).toBe(false);
  });

  it('is false for malformed / short thread ids', () => {
    expect(isGroupThreadId('sendblue:owner')).toBe(false);
    expect(isGroupThreadId('sendblue')).toBe(false);
    expect(isGroupThreadId('')).toBe(false);
  });

  it('only the third segment being exactly `g` counts', () => {
    expect(isGroupThreadId('sendblue:owner:group:x')).toBe(false); // 'group' !== 'g'
    expect(isGroupThreadId('a:b:g')).toBe(true);
  });
});
