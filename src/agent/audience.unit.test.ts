import { afterEach, describe, expect, it } from 'vitest';
import {
  attenuate,
  audienceForSchedule,
  authorityForToolset,
  HOST_GRANTS,
  isAuthoritySubset,
  OWNER_DM_AUTHORITY,
  READONLY_GRANTS,
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
    expect(a).toEqual({ kind: 'agent', mailbox: { by: 'person', person: 'Kate' } });
  });

  it('a null audience derives from threadId + outputTarget (the common per-person case)', () => {
    expect(
      scheduleAudience({ threadId: 'sendblue:x:kate', outputTarget: 'user', audience: null }),
    ).toEqual({
      kind: 'agent',
      mailbox: { by: 'thread', threadId: 'sendblue:x:kate' },
    });
    expect(
      scheduleAudience({ threadId: 'sendblue:x:owner', outputTarget: 'silent', audience: null }),
    ).toEqual({
      kind: 'nobody',
    });
  });

  it("audienceForSchedule: silent → nobody, else → the creating thread's AGENT", () => {
    expect(audienceForSchedule('t', 'silent')).toEqual({ kind: 'nobody' });
    expect(audienceForSchedule('t', 'user')).toEqual({
      kind: 'agent',
      mailbox: { by: 'thread', threadId: 't' },
    });
  });

  it("stored 'nobody' and its legacy spelling 'household' both parse to nobody", () => {
    for (const stored of ['nobody', 'household']) {
      expect(
        scheduleAudience({ threadId: 't', outputTarget: 'user', audience: stored }),
      ).toEqual({ kind: 'nobody' });
    }
  });
});

describe('subjectName', () => {
  it('a byPerson mailbox resolves to the roster name', () => {
    expect(
      subjectName({ kind: 'agent', mailbox: { by: 'person', person: 'Kate' } }, config),
    ).toBe('Kate');
    expect(
      subjectName({ kind: 'agent', mailbox: { by: 'person', person: '+17193146820' } }, config),
    ).toBe('Kate');
  });

  it('nobody and unresolved threads default to the owner', () => {
    expect(subjectName({ kind: 'nobody' }, config)).toBe('Devon');
    expect(
      subjectName({ kind: 'agent', mailbox: { by: 'thread', threadId: 'internal:xyz' } }, config),
    ).toBe('Devon');
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

  it('authorityForToolset maps presets to grant bundles (host is the default)', () => {
    expect(authorityForToolset('host')).toEqual(HOST_GRANTS);
    expect(authorityForToolset('readonly')).toEqual(READONLY_GRANTS);
    expect(authorityForToolset(undefined)).toEqual(HOST_GRANTS);
  });

  it('readonly holds only read-side grants; host adds mutation + the registries', () => {
    expect(READONLY_GRANTS).toEqual(['file_read', 'memory_read', 'runs_read']);
    for (const g of ['bash', 'file_write', 'memory_write', 'credentials', 'mcp']) {
      expect(READONLY_GRANTS).not.toContain(g);
      expect(HOST_GRANTS).toContain(g);
    }
  });

  it('attenuate intersects preset grants with the parent authority', () => {
    // A host child of a FAMILY DM comes up without the owner-facing registries.
    const familyChild = attenuate(HOST_GRANTS, TRUSTED_DM_AUTHORITY);
    expect(familyChild).not.toContain('credentials');
    expect(familyChild).not.toContain('mcp');
    expect(familyChild).toContain('bash');
    // A host child of an OWNER DM keeps the full bundle.
    expect(attenuate(HOST_GRANTS, OWNER_DM_AUTHORITY)).toEqual(HOST_GRANTS);
  });

  it('conversation roots: owner DM ⊇ trusted DM; only owner DMs hold the registries', () => {
    expect(isAuthoritySubset(TRUSTED_DM_AUTHORITY, OWNER_DM_AUTHORITY)).toBe(true);
    expect(TRUSTED_DM_AUTHORITY).not.toContain('credentials');
    expect(TRUSTED_DM_AUTHORITY).not.toContain('mcp');
    expect(OWNER_DM_AUTHORITY).toContain('credentials');
    expect(OWNER_DM_AUTHORITY).toContain('mcp');
  });
});
