import { afterEach, describe, expect, it } from 'vitest';
import {
  audienceForSchedule,
  authorityForToolset,
  isAuthoritySubset,
  resolveMemberThread,
  resolveRosterMember,
  scheduleAudience,
  subjectName,
  TRUSTED_DM_AUTHORITY,
} from './audience.js';
import { normalize } from '../gateway/auth.js';
import { makeConfig } from '../../tests/factories.js';

const config = makeConfig({
  owner: { name: 'Devon', identities: ['+15551230000'] },
  family: [{ name: 'Kate', identities: ['+17193146820'] }],
});

describe('scheduleAudience', () => {
  it('an explicit person: audience wins over the creating thread (cross-person, #4)', () => {
    // Devon creates a schedule in HIS thread FOR Kate — it must resolve to Kate, not his thread.
    const a = scheduleAudience({
      threadId: 'sendblue:x:devon',
      outputTarget: 'user',
      audience: 'person:Kate',
    });
    expect(a).toEqual({ kind: 'person', person: 'Kate' });
  });

  it('a null audience derives from threadId + outputTarget (the common per-person case)', () => {
    expect(
      scheduleAudience({ threadId: 'sendblue:x:kate', outputTarget: 'user', audience: null }),
    ).toEqual({
      kind: 'thread',
      threadId: 'sendblue:x:kate',
    });
    expect(
      scheduleAudience({ threadId: 'sendblue:x:owner', outputTarget: 'silent', audience: null }),
    ).toEqual({
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

describe('resolveRosterMember (shared matcher)', () => {
  // Identity consolidation (fix/code-review-sweep): the matcher now normalizes through the SAME
  // shared `normalize` the authorizer uses (was a hand-mirrored `normalizeLoose`). Matching across
  // phone formatting variants — the behavior that must be preserved — is pinned here.
  it('matches a roster identity across phone formatting variants', () => {
    for (const variant of ['+17193146820', '+1 (719) 314-6820', '1 719 314 6820']) {
      expect(resolveRosterMember(variant, config)?.name).toBe('Kate');
      // The matcher's canonicalization agrees with the shared normalizer.
      expect(normalize(variant)).toBe(normalize('+17193146820'));
    }
  });

  it('resolves by name and returns the first identity; unknown → null', () => {
    expect(resolveRosterMember('Kate', config)).toEqual({ name: 'Kate', identity: '+17193146820' });
    expect(resolveRosterMember('Nobody', config)).toBeNull();
    expect(resolveRosterMember('+19999999999', config)).toBeNull();
  });
});

describe('resolveMemberThread (shared resolve tail)', () => {
  const savedFrom = process.env.SENDBLUE_FROM_NUMBER;
  afterEach(() => {
    if (savedFrom === undefined) delete process.env.SENDBLUE_FROM_NUMBER;
    else process.env.SENDBLUE_FROM_NUMBER = savedFrom;
  });

  it('returns an existing bound DM as-is (normalizing the lookup identity)', async () => {
    let asked: string | undefined;
    const store = {
      findDmThreadForSender: async (id: string) => {
        asked = id;
        return 'sendblue:existing';
      },
    };
    const thread = await resolveMemberThread(store, '+1 (719) 314-6820');
    expect(thread).toBe('sendblue:existing');
    expect(asked).toBe('+17193146820'); // looked up under the canonical identity
  });

  it('constructs a Sendblue DM id when no thread exists and a from-number is set', async () => {
    process.env.SENDBLUE_FROM_NUMBER = '+15550000000';
    const store = { findDmThreadForSender: async () => null };
    const thread = await resolveMemberThread(store, '+17193146820');
    expect(thread).toBeTypeOf('string');
    expect(thread).not.toBeNull();
  });

  it('returns null when no thread exists AND no from-number is configured', async () => {
    delete process.env.SENDBLUE_FROM_NUMBER;
    const store = { findDmThreadForSender: async () => null };
    expect(await resolveMemberThread(store, '+17193146820')).toBeNull();
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
