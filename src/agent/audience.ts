import type { SunnyConfig } from '../config/index.js';

/**
 * Audience — the logical recipient of a durable run (run-audiences D-RA2). Pure addressing: it
 * says WHO a run is for, and resolves to a delivery Thread through the single delivery bus
 * (`deliver` in `runShell.ts`). It replaces the old `user | parent | silent` output target.
 * Node-free (types + a config-only helper), so workflow code imports it at module scope.
 *
 *  - thread    → deliver to a specific thread. Bound (a real conversation) → gateway; detached
 *                (a `subagent:` inbox) → append + wake. The common case: a job/schedule replies to
 *                the thread it came from, which is already the right person in a family.
 *  - person    → resolve a roster member to their bound DM at delivery time (cross-person sends).
 *  - parent    → report to the spawning run's inbox (attributed via from*).
 *  - household → a fan-out hub with no single recipient: NO terminal auto-delivery (the run reaches
 *                people via the `message` tool). A household run with no messaging grant is silent.
 */
export type Audience =
  | { kind: 'thread'; threadId: string }
  | { kind: 'person'; person: string }
  | { kind: 'parent'; threadId: string; fromId?: string; fromName?: string }
  | { kind: 'household' };

/** A run's authority: the set of grant-name strings it was endowed (run-audiences D-RA5). A
 *  spawned run's authority MUST be a subset of its creator's (monotone attenuation). String array
 *  (not Set) so it rides in a serializable WDK workflow input. */
export type Authority = string[];

/** True iff `child` ⊆ `parent` by set inclusion — the attenuation invariant checked at spawn. */
export function isAuthoritySubset(child: Authority, parent: Authority): boolean {
  const p = new Set(parent);
  return child.every((g) => p.has(g));
}

/** The full authority of a trusted-DM conversation turn (owner or family) — the ROOT of the
 *  spawn derivation tree (run-audiences D-RA5). A group turn's root is `['memory']` (no host,
 *  no delegation/scheduling); delegation is trusted-DM-only, so a spawn's parent authority is
 *  this set. */
export const TRUSTED_DM_AUTHORITY: Authority = [
  'bash',
  'file_read',
  'memory',
  'message',
  'schedule',
  'delegate',
];

/** The grants a child's least-privilege toolset preset endows (run-audiences D-RA5). Every child
 *  can always report (`send_message` to its parent) — that is inherent, not a grant. */
export function authorityForToolset(toolset: 'host' | 'readonly' | 'none' | undefined): Authority {
  switch (toolset) {
    case 'host':
      return ['bash', 'file_read'];
    case 'readonly':
      return ['file_read'];
    default:
      return [];
  }
}

/**
 * Build the delivery audience a legacy schedule/job row implies (run-audiences D-RA11: audience is
 * derivable from the existing `threadId` + `output_target`, so no destructive migration is needed):
 * `silent` → household (record-only, no delivery); anything else → the creating thread.
 */
export function audienceForSchedule(threadId: string, outputTarget: string): Audience {
  return outputTarget === 'silent' ? { kind: 'household' } : { kind: 'thread', threadId };
}

/**
 * The delivery audience for a schedule row (run-audiences #4). An explicit `audience` column wins
 * (e.g. `person:Kate` — the owner scheduled a reminder FOR a family member, so it delivers to them
 * regardless of the creating thread); otherwise it is derived from `threadId` + `outputTarget`
 * (the common per-person case, where each person's schedules live in their own thread).
 * Encoding: `person:<name-or-identity>` | `household` | `thread:<id>`.
 */
export function scheduleAudience(row: {
  threadId: string;
  outputTarget: string;
  audience: string | null;
}): Audience {
  const a = row.audience?.trim();
  if (a) {
    const sep = a.indexOf(':');
    const kind = sep === -1 ? a : a.slice(0, sep);
    const rest = sep === -1 ? '' : a.slice(sep + 1);
    if (kind === 'person' && rest) return { kind: 'person', person: rest };
    if (kind === 'household') return { kind: 'household' };
    if (kind === 'thread' && rest) return { kind: 'thread', threadId: rest };
  }
  return audienceForSchedule(row.threadId, row.outputTarget);
}

/**
 * The name of the person a run acts for / reports to, for prompt framing + ownership (D-RA4),
 * derived from the audience. `thread` resolves the thread's roster subject; `household`/unresolved
 * → the owner. Sunny's *identity* is always the owner's assistant; only the beneficiary changes.
 */
export function subjectName(audience: Audience, config: SunnyConfig): string {
  if (audience.kind === 'person') {
    const match = rosterMatch(audience.person, config);
    return match ?? audience.person;
  }
  if (audience.kind === 'thread') {
    const name = subjectOfThread(audience.threadId, config);
    if (name) return name;
  }
  return config.owner.name;
}

/** Resolve a roster name/identity to a canonical roster name, or null if not on the roster. */
export function rosterMatch(person: string, config: SunnyConfig): string | null {
  const roster = [
    { name: config.owner.name, identities: config.owner.identities },
    ...config.family,
  ];
  const wanted = person.trim().toLowerCase();
  const byName = roster.find((p) => p.name.toLowerCase() === wanted);
  if (byName) return byName.name;
  const byId = roster.find((p) => p.identities.some((id) => normalizeLoose(id) === normalizeLoose(person)));
  return byId?.name ?? null;
}

/** A thread id encodes its contact (Sendblue `...:<base64url(contact)>`); if that decodes to a
 *  roster identity we know whose thread it is. Best-effort — returns null for group/internal ids. */
function subjectOfThread(threadId: string, config: SunnyConfig): string | null {
  const parts = threadId.split(':');
  if (parts.length < 3 || parts[2] === 'g') return null; // group or malformed
  let contact: string;
  try {
    contact = Buffer.from(parts[2]!, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  return rosterMatch(contact, config);
}

/** Loose identity normalization for matching (mirrors gateway/auth `normalize` without importing
 *  it — keeps this module free of the auth module's deps): E.164-ish digits, lowercased email. */
function normalizeLoose(identity: string): string {
  const t = identity.trim();
  if (t.includes('@')) return t.toLowerCase();
  const digits = t.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}
