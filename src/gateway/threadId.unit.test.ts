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

  it('every Slack thread id reads as non-group (add-slack-channel D5 guard)', () => {
    // Chat SDK Slack ids are `slack:<channelId>:<thread_ts>` — the third segment
    // is a message timestamp and can never equal 'g', for DMs and channels alike.
    expect(isGroupThreadId('slack:D0DEVON:1721000000.000100')).toBe(false);
    expect(isGroupThreadId('slack:C0GENERAL:1721000000.000200')).toBe(false);
    expect(isGroupThreadId('slack:G0LEGACY:1721000000.000300')).toBe(false);
  });
});
