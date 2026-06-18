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
});

describe('Authorizer.authorize', () => {
  const config = makeConfig({
    owner: { name: 'Devon', identities: ['+1 (555) 123-4567', 'devon@example.com'] },
    allowGroups: true,
  });

  it('authorizes the owner as owner (across phone formatting)', () => {
    const auth = new Authorizer(config);
    expect(auth.authorize('+15551234567', false)).toEqual({ authorized: true, isOwner: true });
    expect(auth.authorize('DEVON@example.com', false)).toEqual({ authorized: true, isOwner: true });
  });

  it('authorizes a non-owner in a group as non-owner when groups are allowed', () => {
    const auth = new Authorizer(config);
    expect(auth.authorize('+15559999999', true)).toEqual({ authorized: true, isOwner: false });
  });

  it('rejects a non-owner DM', () => {
    const auth = new Authorizer(config);
    expect(auth.authorize('+15559999999', false)).toEqual({ authorized: false, isOwner: false });
  });

  it('rejects a non-owner group message when allowGroups is off', () => {
    const auth = new Authorizer(makeConfig({ ...config, allowGroups: false }));
    expect(auth.authorize('+15559999999', true)).toEqual({ authorized: false, isOwner: false });
    // …but the owner is still recognized in a group regardless of allowGroups.
    expect(auth.authorize('+15551234567', true)).toEqual({ authorized: true, isOwner: true });
  });
});
