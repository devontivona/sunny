import type { SunnyConfig } from '../config/index.js';
import { normalize } from '../gateway/auth.js';

/**
 * A Mailbox names a conversation, two ways (unified-voice-layer, audience collapse):
 *  - byPerson: a LOGICAL reference — a roster member's DM, resolved at delivery time (their
 *    existing DM or one constructed from the send number). Late-bound, portable across
 *    machines and channel changes; the form standing-schedule files carry.
 *  - byThread: a PHYSICAL reference — a specific conversation log by id. Early-bound; the
 *    only way to name a GROUP thread, a created-here context, or a worker's detached inbox.
 */
export type Mailbox = { by: 'person'; person: string } | { by: 'thread'; threadId: string };

/**
 * Audience — WHO READS a run's final text (unified-voice-layer, audience collapse). One
 * concept for every run profile, three values:
 *
 *  - nobody → no one reads it: the terminal text is recorded in run history only, and no
 *    conversation is woken (silent pipeline/maintenance jobs). The run may still deliberately
 *    fan out via the `message` tool — that is addressed speech, not its terminal lane.
 *  - agent(mailbox) → that mailbox's AGENT reads it: the text is appended to the thread as an
 *    attributed report (`<identity.name> (<identity.kind>): …`) and the thread's conversation
 *    loop is woken to mediate it. The ONLY terminal audience a worker (subagent / scheduled
 *    run) can have; it absorbs the former `parent`, `thread`, and worker-`person` kinds.
 *  - chat(mailbox) → that mailbox's PEOPLE read it: the run participates in the conversation
 *    itself, gateway-delivered. Reserved for conversational turns — spawn surfaces cannot
 *    construct it (the one-speaker rule as a constructibility gate, like authority
 *    attenuation); only the router mints chat runs, in response to something arriving on a
 *    thread.
 *
 * Replaces the four-value `thread | person | parent | household` set (and, before that, the
 * `user | parent | silent` output target). Attribution is NOT part of the audience — it is
 * the reporting run's own identity, passed to the bus alongside the text.
 * Node-free (types + config-only helpers), so workflow code imports it at module scope.
 */
export type Audience =
  | { kind: 'nobody' }
  | { kind: 'agent'; mailbox: Mailbox }
  | { kind: 'chat'; mailbox: Mailbox };

/** A reporting run's identity — stamps its reports (`<name> (<kind>): …`) and carries the
 *  steering handle. Lives on the RunSpec, not in the audience (audience is pure address). */
export interface RunIdentity {
  id?: string;
  name: string;
  kind: 'subagent' | 'scheduled';
}

/** One endowable capability (run-audiences D-RA5) — the AUTHORITY axis: what a run may DO.
 *  Each grant maps to a concrete tool bundle (see `grantTools` in `workflows/runShell.ts`):
 *   - file_read     → file_read
 *   - memory_read   → read_topic, recall_history
 *   - runs_read     → list_runs
 *   - bash          → bash (credential injection rides its `credentials` argument)
 *   - file_write    → file_write, file_edit
 *   - memory_write  → memory_write
 *   - credentials   → credential_manage (vault discovery/registration)
 *   - mcp           → mcp_manage + the enabled MCP servers' live tools
 *   - schedule      → schedule_create, cancel_run
 *   - delegate      → delegate_task
 *  How a run SPEAKS (its reply lane, `message` fan-out, send_image) is NOT a grant — it derives
 *  from the run's AUDIENCE (masked by trust for conversations). See README "Capability model". */
export type Grant =
  | 'file_read'
  | 'memory_read'
  | 'runs_read'
  | 'bash'
  | 'file_write'
  | 'memory_write'
  | 'credentials'
  | 'mcp'
  | 'schedule'
  | 'delegate';

/** A run's authority: the set of grants it was endowed (run-audiences D-RA5). A spawned run's
 *  authority MUST be a subset of its creator's (monotone attenuation). String array (not Set)
 *  so it rides in a serializable WDK workflow input. */
export type Authority = string[];

/** True iff `child` ⊆ `parent` by set inclusion — the attenuation invariant checked at spawn. */
export function isAuthoritySubset(child: Authority, parent: Authority): boolean {
  const p = new Set(parent);
  return child.every((g) => p.has(g));
}

/** `requested ∩ parent` — monotone attenuation for PRESET-derived grants: a preset asks for its
 *  full bundle and receives what its parent can actually endow (e.g. a host child of a family DM
 *  gets host minus credentials/mcp). Explicit grant requests use `isAuthoritySubset` + refusal
 *  instead, so a run that NAMED a grant hears "no" rather than silently losing it. */
export function attenuate(requested: Authority, parent: Authority): Authority {
  const p = new Set(parent);
  return requested.filter((g) => p.has(g));
}

/** The read-side preset: inspect without mutating. Safe enough for untrusted-content work. */
export const READONLY_GRANTS: Authority = ['file_read', 'memory_read', 'runs_read'];

/** The act-side preset: everything readonly has, plus host mutation and the registries. */
export const HOST_GRANTS: Authority = [
  ...READONLY_GRANTS,
  'bash',
  'file_write',
  'memory_write',
  'credentials',
  'mcp',
];

/** The authority of a trusted-DM conversation turn (owner OR family) — a spawn-derivation ROOT
 *  (run-audiences D-RA5). Family DMs hold host reach but NOT the owner-facing registries
 *  (credentials/mcp); a group turn's root is `GROUP_AUTHORITY`. */
export const TRUSTED_DM_AUTHORITY: Authority = [
  ...READONLY_GRANTS,
  'bash',
  'file_write',
  'memory_write',
  'schedule',
  'delegate',
];

/** The owner-DM root: trusted-DM plus the owner-facing registries. */
export const OWNER_DM_AUTHORITY: Authority = [...TRUSTED_DM_AUTHORITY, 'credentials', 'mcp'];

/** A group turn's root: memory only (no host reach, no spawning; design D5). */
export const GROUP_AUTHORITY: Authority = ['memory_read', 'memory_write'];

/** The grants a child's least-privilege toolset preset REQUESTS (run-audiences D-RA5); the
 *  supervisor attenuates them against the parent's authority at spawn. Reporting back to the
 *  parent is inherent (the final text), not a grant. */
export function authorityForToolset(toolset: 'host' | 'readonly' | undefined): Authority {
  return toolset === 'readonly' ? READONLY_GRANTS : HOST_GRANTS;
}

/**
 * THE parser for a stored audience REFERENCE string — the encoding schedule rows and
 * standing-file frontmatter carry: `person:<name-or-identity>` | `nobody` | `thread:<id>`
 * (`household` accepted as the legacy spelling of `nobody`). Refs address WORKERS, so
 * person/thread parse to `agent` mailboxes. Returns null on an unrecognized ref. Every
 * site that reads or validates the encoding goes through this (code-review 2026-07-15:
 * three independent hand-rolled parsers had already diverged).
 */
export function parseAudienceRef(ref: string): Audience | null {
  const a = ref.trim();
  const sep = a.indexOf(':');
  const kind = sep === -1 ? a : a.slice(0, sep);
  const rest = sep === -1 ? '' : a.slice(sep + 1);
  if (kind === 'person' && rest) return { kind: 'agent', mailbox: { by: 'person', person: rest } };
  if (kind === 'nobody' || kind === 'household') return { kind: 'nobody' };
  if (kind === 'thread' && rest) return { kind: 'agent', mailbox: { by: 'thread', threadId: rest } };
  return null;
}

/** The canonical serialization of an audience ref (`household` → `nobody`), or null when the
 *  ref is unrecognized — validation and normalization in one place. */
export function canonicalAudienceRef(ref: string): string | null {
  const parsed = parseAudienceRef(ref);
  if (!parsed) return null;
  if (parsed.kind === 'nobody') return 'nobody';
  if (parsed.kind === 'agent') {
    return parsed.mailbox.by === 'person'
      ? `person:${parsed.mailbox.person}`
      : `thread:${parsed.mailbox.threadId}`;
  }
  return null; // chat is never a stored ref (one-speaker rule)
}

/**
 * The audience for a schedule row (run-audiences #4; D-VL10). An explicit `audience`
 * column/frontmatter wins (e.g. `person:Kate` — scheduled FOR a family member, so its reports
 * land on their conversation loop regardless of the creating thread); a null audience means
 * the creating thread's agent (the common per-person case, where each person's schedules live
 * in their own thread). The retired `output_target` flag was backfilled into the audience
 * encoding by migration 0013 — no shim survives.
 */
export function scheduleAudience(row: { threadId: string; audience: string | null }): Audience {
  const a = row.audience?.trim();
  if (a) {
    const parsed = parseAudienceRef(a);
    if (parsed) return parsed;
  }
  return { kind: 'agent', mailbox: { by: 'thread', threadId: row.threadId } };
}

/**
 * The name of the person a run acts for / reports to, for prompt framing + ownership (D-RA4),
 * derived from the audience's mailbox. byPerson → that person; byThread → the thread's roster
 * subject; nobody/unresolved → the owner. Sunny's *identity* is always the owner's assistant;
 * only the beneficiary changes.
 */
export function subjectName(audience: Audience, config: SunnyConfig): string {
  if (audience.kind !== 'nobody') {
    const m = audience.mailbox;
    if (m.by === 'person') {
      const match = rosterMatch(m.person, config);
      return match ?? m.person;
    }
    const name = subjectOfThread(m.threadId, config);
    if (name) return name;
  }
  return config.owner.name;
}

/**
 * Resolve a roster name/identity to the canonical member (name + first identity), or null if not
 * on the roster (owner + family). The SINGLE matcher — every person-resolution site (framing,
 * ownership, relay send, scheduled fan-out) goes through this, so matching precedence and
 * normalization can't drift between "who is this run framed for" and "where does it deliver".
 */
export function resolveRosterMember(
  person: string,
  config: SunnyConfig,
): { name: string; identity: string } | null {
  const roster = [
    { name: config.owner.name, identities: config.owner.identities },
    ...config.family,
  ];
  const wanted = person.trim();
  const match =
    roster.find((p) => p.name.toLowerCase() === wanted.toLowerCase()) ??
    roster.find((p) => p.identities.some((id) => normalize(id) === normalize(wanted)));
  if (!match || match.identities.length === 0) return null;
  return { name: match.name, identity: match.identities[0]! };
}

/** Resolve a roster name/identity to a canonical roster name, or null. Thin over `resolveRosterMember`. */
export function rosterMatch(person: string, config: SunnyConfig): string | null {
  return resolveRosterMember(person, config)?.name ?? null;
}

/** A thread id encodes its contact (Sendblue `...:<base64url(contact)>`); if that decodes to
 *  a roster member we know whose conversation it is — even before they have ever spoken in
 *  it (a never-contacted DM minted by a person-audience report). Best-effort — null for
 *  group/internal ids and off-roster contacts. */
export function rosterMemberOfThread(
  threadId: string,
  config: SunnyConfig,
): { name: string; identity: string } | null {
  const parts = threadId.split(':');
  if (parts.length < 3 || parts[2] === 'g') return null; // group or malformed
  let contact: string;
  try {
    contact = Buffer.from(parts[2]!, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  return resolveRosterMember(contact, config);
}

/** The roster NAME a thread id encodes (see {@link rosterMemberOfThread}). */
function subjectOfThread(threadId: string, config: SunnyConfig): string | null {
  return rosterMemberOfThread(threadId, config)?.name ?? null;
}

/**
 * Resolve a roster member's identity to their BOUND DM thread: their existing DM if we have one,
 * else a Sendblue DM id constructed deterministically from `SENDBLUE_FROM_NUMBER`. Returns null
 * only when no thread exists AND no from-number is configured to construct one. The identity is
 * canonicalized through the gateway `normalize` (the same encoding the adapter uses for thread
 * ids), so a resolved member addresses the thread the adapter would. The shared tail of every
 * cross-person send (`personRelayStepBody`, `scheduledMessageStep`) — behavior-identical to the
 * copies they replace. Node-free at module scope (runtime deps are dynamic-imported), so workflow
 * code can import it without pulling Node into the module graph.
 */
export async function resolveMemberThread(
  store: { findDmThreadForSender(identity: string): Promise<string | null> },
  rawIdentity: string,
): Promise<string | null> {
  const { sendblueDmThreadId } = await import('../gateway/threadId.js');
  const identity = normalize(rawIdentity);
  const existing = await store.findDmThreadForSender(identity);
  if (existing) return existing;
  const from = process.env.SENDBLUE_FROM_NUMBER;
  return from ? sendblueDmThreadId(from, identity) : null;
}
