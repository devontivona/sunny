import { describe, expect, it } from 'vitest';
import { Authorizer, normalize } from './auth.js';
import { makeConfig } from '../../tests/factories.js';

describe('normalize (identity)', () => {
  it('reduces a phone number to digits with a leading +', () => {
    expect(normalize('+1 (555) 123-4567')).toBe('+15551234567');
    expect(normalize('15551234567')).toBe('+15551234567');
  });

  it('treats formatting variants of the same number as equal', () => {
    expect(normalize('+1 (555) 123-4567')).toBe(normalize('+15551234567'));
  });

  it('lowercases and trims emails (no + prefix)', () => {
    expect(normalize('  Devon@Example.COM ')).toBe('devon@example.com');
  });

  it('passes Slack member ids through verbatim (lowercased) — never the phone strip', () => {
    // Regression (add-slack-channel): ids that merely CONTAIN digits must not take
    // the phone branch, or `U0123ABC` would collapse to `+0123` and collide.
    expect(normalize('U0123ABC')).toBe('u0123abc');
    expect(normalize(' U0AAAAAAA ')).toBe('u0aaaaaaa');
    // Phone formatting variants still normalize as before.
    expect(normalize('+1 (555) 123-4567')).toBe('+15551234567');
  });
});

describe('Authorizer — Slack member ids as roster identities (add-slack-channel)', () => {
  const config = makeConfig({
    owner: { name: 'Devon', identities: ['+15551234567', 'U0AAAAAAA'] },
    family: [],
    allowGroups: true,
  });

  it('authorizes the owner by Slack member id in a DM', () => {
    const auth = new Authorizer(config);
    expect(auth.authorize('U0AAAAAAA', false)).toEqual({
      authorized: true,
      isTrusted: true,
      isOwner: true,
      role: 'owner',
    });
  });

  it('rejects an unrostered Slack member id (fail-closed DM)', () => {
    const auth = new Authorizer(config);
    expect(auth.authorize('U9OUTSIDER', false).authorized).toBe(false);
  });
});

describe('Authorizer.authorize — tiers (multiplayer-family)', () => {
  const config = makeConfig({
    owner: { name: 'Devon', identities: ['+1 (555) 123-4567', 'devon@example.com'] },
    family: [{ name: 'Kate', identities: ['+1 (719) 314-6820'] }],
    allowGroups: true,
  });

  it('authorizes the owner as owner + trusted (across phone formatting)', () => {
    const auth = new Authorizer(config);
    expect(auth.authorize('+15551234567', false)).toEqual({
      authorized: true,
      isTrusted: true,
      isOwner: true,
      role: 'owner',
    });
    expect(auth.authorize('DEVON@example.com', false)).toEqual({
      authorized: true,
      isTrusted: true,
      isOwner: true,
      role: 'owner',
    });
  });

  it('authorizes a family DM as trusted, non-owner (across phone formatting)', () => {
    const auth = new Authorizer(config);
    expect(auth.authorize('+17193146820', false)).toEqual({
      authorized: true,
      isTrusted: true,
      isOwner: false,
      role: 'family',
    });
  });

  it('rejects a non-trusted DM', () => {
    const auth = new Authorizer(config);
    expect(auth.authorize('+15559999999', false)).toEqual({
      authorized: false,
      isTrusted: false,
      isOwner: false,
      role: null,
    });
  });
});

describe('Authorizer.authorize — group membership (multiplayer-family D5)', () => {
  const config = makeConfig({
    owner: { name: 'Devon', identities: ['+15551234567'] },
    family: [
      { name: 'Kate', identities: ['+17193146820'] },
      { name: 'Sam', identities: ['+15550001111'] },
    ],
    allowGroups: true,
  });

  it('authorizes an all-trusted group (owner present)', () => {
    const auth = new Authorizer(config);
    const res = auth.authorize('+17193146820', true, ['+15551234567', '+17193146820']);
    expect(res.authorized).toBe(true);
    expect(res.role).toBe('family');
  });

  it('authorizes a family-only group (owner NOT present)', () => {
    const auth = new Authorizer(config);
    const res = auth.authorize('+17193146820', true, ['+17193146820', '+15550001111']);
    expect(res.authorized).toBe(true);
  });

  it('silences a group with any outsider', () => {
    const auth = new Authorizer(config);
    const res = auth.authorize('+17193146820', true, ['+17193146820', '+15559999999']);
    expect(res.authorized).toBe(false);
  });

  it('fails closed when the roster is unavailable', () => {
    const auth = new Authorizer(config);
    expect(auth.authorize('+17193146820', true, undefined).authorized).toBe(false);
  });

  it('rejects a group entirely when allowGroups is off, but owner DM still works', () => {
    const off = new Authorizer(makeConfig({ ...config, allowGroups: false }));
    expect(off.authorize('+17193146820', true, ['+17193146820']).authorized).toBe(false);
    expect(off.authorize('+15551234567', false).authorized).toBe(true);
  });

  it('rejects a non-trusted sender even when the listed participants are trusted', () => {
    const auth = new Authorizer(config);
    const res = auth.authorize('+15559999999', true, ['+15559999999', '+15551234567']);
    expect(res.authorized).toBe(false);
  });
});
