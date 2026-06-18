import type { SunnyConfig } from '../config/index.js';

export interface AuthResult {
  /** Whether the agent may act on this message at all. */
  authorized: boolean;
  /** Whether the sender is the owner (Devon). Drives action-gating later (R1). */
  isOwner: boolean;
}

/**
 * Sender authorization at the gateway (messaging-gateway D-MG6, task 2.4).
 *
 * Phase 1 is a simple allowlist of Devon's identities (phone/email). The fuller
 * cryptographic DM-pairing model (security-permissions D-SEC2, task 5.7) wraps
 * this later. Owner tagging here is the groundwork for end-to-end `isOwner`
 * action-gating (R1 / task 5.1a):
 *
 * - Owner DM/group message  → authorized + owner.
 * - Non-owner in a group    → authorized + non-owner IF groups are allowed
 *                             (answerable, but cannot trigger consequence/approve).
 * - Anyone else             → not authorized (agent is not triggered).
 */
export class Authorizer {
  private readonly ownerIdentities: Set<string>;
  private readonly allowGroups: boolean;

  constructor(config: SunnyConfig) {
    this.ownerIdentities = new Set(config.owner.identities.map(normalize));
    this.allowGroups = config.allowGroups;
  }

  authorize(senderId: string, isGroup: boolean): AuthResult {
    const isOwner = this.ownerIdentities.has(normalize(senderId));
    if (isOwner) return { authorized: true, isOwner: true };
    if (isGroup && this.allowGroups) return { authorized: true, isOwner: false };
    return { authorized: false, isOwner: false };
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
