import { describe, expect, it } from 'vitest';
import {
  audienceForSchedule,
  authorityForToolset,
  isAuthoritySubset,
  scheduleAudience,
  subjectName,
  TRUSTED_DM_AUTHORITY,
} from './audience.js';
import { makeConfig } from '../../tests/factories.js';

const config = makeConfig({
  owner: { name: 'Devon', identities: ['+15551230000'] },
  family: [{ name: 'Kate', identities: ['+17193146820'] }],
});

describe('scheduleAudience', () => {
  it('an explicit person: audience wins over the creating thread (cross-person, #4)', () => {
    // Devon creates a schedule in HIS thread FOR Kate — it must resolve to Kate, not his thread.
    const a = scheduleAudience({ threadId: 'sendblue:x:devon', outputTarget: 'user', audience: 'person:Kate' });
    expect(a).toEqual({ kind: 'person', person: 'Kate' });
  });

  it('a null audience derives from threadId + outputTarget (the common per-person case)', () => {
    expect(scheduleAudience({ threadId: 'sendblue:x:kate', outputTarget: 'user', audience: null })).toEqual({
      kind: 'thread',
      threadId: 'sendblue:x:kate',
    });
    expect(scheduleAudience({ threadId: 'sendblue:x:owner', outputTarget: 'silent', audience: null })).toEqual({
      kind: 'household',
    });
  });

  it('audienceForSchedule: silent → household, else → thread', () => {
    expect(audienceForSchedule('t', 'silent')).toEqual({ kind: 'household' });
    expect(audienceForSchedule('t', 'user')).toEqual({ kind: 'thread', threadId: 't' });
  });
});

describe('subjectName', () => {
  it('a person audience resolves to the roster name', () => {
    expect(subjectName({ kind: 'person', person: 'Kate' }, config)).toBe('Kate');
    expect(subjectName({ kind: 'person', person: '+17193146820' }, config)).toBe('Kate');
  });

  it('household and unresolved threads default to the owner', () => {
    expect(subjectName({ kind: 'household' }, config)).toBe('Devon');
    expect(subjectName({ kind: 'thread', threadId: 'internal:xyz' }, config)).toBe('Devon');
  });
});

describe('authority attenuation', () => {
  it('isAuthoritySubset is set inclusion', () => {
    expect(isAuthoritySubset(['file_read'], TRUSTED_DM_AUTHORITY)).toBe(true);
    expect(isAuthoritySubset(['bash', 'file_read'], ['file_read'])).toBe(false);
  });

  it('authorityForToolset maps presets to grant sets', () => {
    expect(authorityForToolset('host')).toEqual(['bash', 'file_read']);
    expect(authorityForToolset('readonly')).toEqual(['file_read']);
    expect(authorityForToolset('none')).toEqual([]);
  });
});
