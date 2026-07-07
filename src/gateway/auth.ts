import type { SunnyConfig } from '../config/index.js';

/** Trust tier of a resolved sender (multiplayer-family D1). `null` = not trusted. */
export type Role = 'owner' | 'family' | null;

export interface AuthResult {
  /** Whether the agent may act on this message at all. */
  authorized: boolean;
  /** Whether the sender's tier is trusted (owner OR family) — drives elevated capabilities. */
  isTrusted: boolean;
  /** Whether the sender is specifically the owner (Devon) — drives owner-only carve-outs. */
  isOwner: boolean;
  /** The resolved tier of the sender ('owner' | 'family' | null). */
  role: Role;
}

/**
 * Sender authorization at the gateway (messaging-gateway D-MG6; multiplayer-family D1/D5).
 *
 * Two trust tiers: the owner (Devon) and `family` — family has the SAME elevated permissions
 * as the owner, but `isOwner` stays distinct so owner-only carve-outs (e.g. editing the owner's
 * USER.md) remain expressible. Identity is the channel-stable address (phone/email); the fuller
 * cryptographic DM-pairing model (security-permissions) wraps this later.
 *
 * - Owner DM / authorized group     → authorized, owner, trusted.
 * - Family DM                       → authorized, family, trusted.
 * - Authorized group (ALL trusted)  → authorized; one outsider silences the whole group, and an
 *                                     undeterminable roster fails CLOSED (not authorized).
 * - Anyone else                     → not authorized (agent is not triggered).
 */
export class Authorizer {
  private readonly ownerIdentities: Set<string>;
  private readonly familyIdentities: Set<string>;
  private readonly allowGroups: boolean;

  constructor(config: SunnyConfig) {
    this.ownerIdentities = new Set(config.owner.identities.map(normalize));
    this.familyIdentities = new Set(config.family.flatMap((p) => p.identities.map(normalize)));
    this.allowGroups = config.allowGroups;
  }

  /** Resolve a sender's trust tier from the rosters (owner wins over family). */
  resolveRole(senderId: string): Role {
    const id = normalize(senderId);
    if (this.ownerIdentities.has(id)) return 'owner';
    if (this.familyIdentities.has(id)) return 'family';
    return null;
  }

  /**
   * Authorize an inbound message. For groups, `participantIds` is the full roster used for the
   * all-trusted membership check (multiplayer-family D5): if it is undefined (roster couldn't be
   * determined) the group fails CLOSED.
   */
  authorize(senderId: string, isGroup: boolean, participantIds?: string[]): AuthResult {
    const role = this.resolveRole(senderId);
    const isTrusted = role !== null;
    const isOwner = role === 'owner';

    if (!isGroup) {
      // DM: only trusted identities may reach the agent.
      return { authorized: isTrusted, isTrusted, isOwner, role };
    }

    // Group: requires groups enabled, a trusted sender, AND every participant trusted.
    if (!this.allowGroups || !isTrusted) {
      return { authorized: false, isTrusted, isOwner, role };
    }
    if (participantIds === undefined) {
      // Roster unavailable → fail closed; we cannot prove the group is all-trusted.
      return { authorized: false, isTrusted, isOwner, role };
    }
    const allTrusted = participantIds.every((id) => this.resolveRole(id) !== null);
    return { authorized: allTrusted, isTrusted, isOwner, role };
  }
}

/** Loosely normalize identities so `+1 (555) 123-4567` and `+15551234567` match. */
export function normalize(identity: string): string {
  const trimmed = identity.trim().toLowerCase();
  // Phone numbers: strip everything but digits and a leading +.
  if (/[0-9]/.test(trimmed) && !trimmed.includes('@')) {
    const digits = trimmed.replace(/[^0-9+]/g, '');
    return digits.startsWith('+') ? digits : `+${digits}`;
  }
  return trimmed;
}
