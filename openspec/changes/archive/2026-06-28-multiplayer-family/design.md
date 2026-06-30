## Context

Sunny is single-user today. The authorization chokepoint is `Authorizer.authorize(senderId, isGroup)` in `src/gateway/auth.ts`, called from `dispatch()` in `src/gateway/sendblue.ts:345`; it returns `{ authorized, isOwner }` by matching `config.owner.identities[]` (normalized phone/email). Powerful tools are gated in `buildTools({ ownerDm })` (`workflows/conversation.ts:191-255`) where `ownerDm = !isGroup` — i.e. capability is keyed to *thread kind*, which is only safe today because non-owner DMs are rejected, making "DM" a reliable proxy for "owner."

Group-ness is derived from the threadId (`isGroupThreadId`, groups are `sendblue:<from>:g:<groupId>`). The group participant roster is *fetchable but not stored*: Chat SDK exposes `thread.getParticipants()` and the Sendblue adapter carries `participants: string[]`. Group subscription happens on first `@mention` (`onNewMention → thread.subscribe()`), after which `onSubscribedMessage` fires. Group attribution already exists — the model sees speaker prefixes like `"Devon (owner): …"` vs `"Bob: …"` (`src/agent/delivery.ts`).

Memory is a single-tenant core (`USER.md`, `SUNNY.md`, `INDEX.md` + topic docs under `~/.sunny/state/memory/`), loaded every turn via `assembleTurnInstructions → buildSystemPrompt → memoryCoreBlock`, self-updated through `memory_write` and committed to the private `state` repo.

There is an in-flight `security-permissions` change whose spec currently frames consequence-gating as *owner-only*. This change must establish the **trust tier** as the gating axis so that later work gates on tier, not literal owner. This change does **not** implement enforcement, approval tiers, or cryptographic pairing.

## Goals / Non-Goals

**Goals:**
- Let designated family members message Sunny (DMs in Phase 1, all-trusted groups in Phase 2) with owner-equivalent permissions.
- Keep a per-person profile document for each family member, mirroring how the owner's `USER.md` works.
- Keep everyone else fully locked out (reject non-trusted DMs; silence any group containing an outsider).
- Shift the capability-gating axis from thread-kind to trust-tier so the model is correct rather than incidental, and so `security-permissions` can build on it.

**Non-Goals:**
- No `friend`/lower-trust tier yet (only shape the data so it can be added later).
- No cryptographic DM-pairing or identity hardening; identity stays the channel-stable address.
- No approval tiers, hard blocklist, or consequence enforcement (those are `security-permissions`).
- No expansion of what tools exist; only *who* gets the existing elevated set.
- No enforcement or authorization logic in skills — skills are model-visible and injection-reachable; the gateway stays the trust boundary (see D7).
- No cross-thread memory sharing of transcripts — per-thread transcripts stay as-is; the per-person docs are the only cross-thread channel.

## Decisions

### D1 — Trust tier replaces the binary owner check
`Authorizer` resolves a sender to `role: 'owner' | 'family' | null` and derives `isTrusted = role !== null`. `AuthResult` becomes `{ authorized, isTrusted, isOwner, role }`. `isOwner` is retained verbatim (literal owner) so owner-only carve-outs stay expressible. Config gains a `family` roster mirroring `owner`: `family: [{ name, identities[] }]`, matched with the existing `normalize()`. Shape generalizes to `friend` later by adding a role + roster, not by reworking the type.

*Alternative considered:* adding family identities directly to `owner.identities`. Rejected — it erases the owner/family distinction needed for per-person docs and the owner-only carve-out, and bakes in the wrong assumption for the future friend tier.

### D2 — Capability gating moves from thread-kind to trust-tier
`buildTools` stops keying the powerful set on `ownerDm = !isGroup` and keys it on `isTrusted` instead. Owner-only capabilities (initially: editing the owner's `USER.md`) stay gated on `isOwner`. Net effect: a family DM gets the elevated toolset by intent; the owner keeps full power; group tool exposure is addressed in D5.

*Alternative considered:* leave thread-kind gating and just add family to the allowlist. Rejected — a family DM would then silently inherit the `ownerDm` branch, which is the *correct* outcome here but for the *wrong* (accidental) reason, and it would mislead the next change.

### D3 — Per-person profile docs under `memory/people/<id>.md`
`SUNNY.md` (operating notes) and the owner's `USER.md` stay global and always-loaded. Each family member gets `memory/people/<id>.md`, where `<id>` is a stable slug derived from their normalized identity. The doc is auto-created on first contact and loaded for the participants *present in the current thread*. `memory_write` routing: owner-facts → `USER.md` (owner only), person-facts → that person's doc, operating notes → `SUNNY.md`. Same files-first, git-committed, capped-with-consolidation model as today.

*Alternative considered (a):* per-principal full core (`memory/users/<id>/USER.md`). Rejected — heavier, duplicates `SUNNY.md` semantics, and over-scopes for a household. *(b):* keep one shared core. Rejected — can't hold distinct people cleanly.

### D4 — Privacy by discretion, not siloing
Per Devon: don't make Sunny amnesiac about him in family threads. The owner's `USER.md` stays loaded in family-facing contexts; a system-prompt instruction tells Sunny to use judgment about repeating one person's facts to another. This is explicitly a behavioral safeguard, not an access-control boundary (the real boundary lands with `security-permissions`).

### D5 — Group authorization = all-trusted-or-silent, fail-closed
On each inbound group message, fetch the roster (`thread.getParticipants()` / adapter `participants`) and authorize only if **every** participant is trusted. Owner need not be present. One outsider → the whole group is silent. Re-check every message (so an outsider added mid-thread silences it). If the roster fetch fails or is empty/unknown → fail closed (do not trigger). Group tool exposure: family groups are trusted, but a shared room is a riskier place to run host-affecting tools and "whose host?" is ambiguous; this change does **not** expand group tool exposure beyond current behavior — the requirement is membership validation + trusted participation. (Revisit when `security-permissions` lands.)

### D7 — Behavior lives in skills/operating-notes; enforcement lives in code
The work splits cleanly along a trust line:

- **Code (mechanical / security-critical) — must not be a skill:** trust-tier and roster resolution (D1), capability gating by tier (D2), group membership validation + fail-closed (D5), loading the correct docs by participant (D3), and write-routing *enforcement* (a non-owner cannot edit `USER.md`). These are the trust boundary; skills are model-visible and reachable by prompt injection, so enforcement can never be pushed into one.
- **Skills / operating-notes (behavior-driving) — should not be hardcoded:** discretion about cross-person disclosure (D4), how to curate a per-person profile doc (what to record, tone), passive-assistant group etiquette (when to chime in vs `stay_silent`), and how Sunny relates to family vs the owner.

This keeps the always-on system prefix byte-stable for prompt caching (behavioral guidance loads on-demand rather than bloating the cached prefix), matches the existing memory(facts)/skill(procedures) split, and lets this behavior evolve without code changes or redeploys. Concretely: the discretion and group-etiquette guidance referenced in D4/D6 SHOULD be authored as a skill (and/or `SUNNY.md` operating notes), not embedded in the cached system prompt. The agent-memory spec's discretion requirement is deliberately worded as "guided by its operating instructions" so a skill/operating-note satisfies it.

### D6 — Group participation without an @mention (subscription bootstrap)
Today Sunny only sees group messages after subscribing, and subscription is triggered by the first `@mention`. For passive-assistant discretion we need Sunny to receive authorized group messages without requiring a mention. Approach: when a group message is delivered to the driver (via mention or any handler the transport fires), run the roster/authorization check; if authorized, `subscribe()` so subsequent messages flow, then let the agent decide per-turn (`send_message`/`stay_silent`). This is bounded by what Sendblue actually delivers to a not-yet-subscribed group — see Risks/Open Questions. Discretion itself reuses the existing `stay_silent` machinery; no new participation primitive is needed.

## Risks / Trade-offs

- **Sendblue may not deliver the bootstrap message for a not-yet-subscribed group without a mention** → Sunny couldn't join an all-family group until first mentioned. Mitigation: verify the transport's delivery behavior during implementation; if a mention is required to bootstrap, accept "first mention subscribes, then discretion thereafter" as the Phase-2 behavior and document it. (Open Question OQ1.)
- **Roster fetch adds a per-message async call and a failure mode** → latency and a fail-closed path that could occasionally silence a legitimate group. Mitigation: fail closed by decision; consider a short-lived per-thread roster cache if latency is a problem (membership re-check still required, so cache must be conservative).
- **Widened trust boundary** → a spoofed/compromised family phone/email gains full owner-equivalent access (including `bash`). Accepted for this change (same trust class already used for the owner); `security-permissions` hardens it later.
- **`isTrusted` toolset includes host-affecting tools for family DMs** → larger blast radius than today. Explicitly accepted by Devon; owner-only carve-outs and future lockdown are the mitigations.
- **Capability gating flip touches a hot path (`buildTools`)** → regression risk for the owner's existing DM/group behavior. Mitigation: preserve current owner behavior exactly (owner DM keeps full power; owner-in-group unchanged unless D5 says otherwise) and cover with unit tests on the tier→toolset mapping.
- **`<id>` slug stability** → if the derived id changes, a person's doc could orphan. Mitigation: derive from the same normalized identity used for auth; treat the normalized identity as the stable key.

## Migration Plan

- Additive config: `config.family` defaults to empty → behavior is unchanged until Devon populates the roster. No migration of existing data required.
- New `memory/people/` directory is created lazily on first family contact; the `state` repo picks it up via the existing commit-on-write path.
- `AuthResult`/event/`messages` row gain role/trust fields; default for existing rows is non-trusted/non-owner consistent with today. DB column addition via a Drizzle migration if a column is added (or derive role at read time to avoid a migration — decide in tasks).
- Rollback: empty the `family` roster (instant return to single-user) and/or revert the gating flip; per-person docs are inert when no family is configured.

## Open Questions

- **OQ1:** Does Sendblue deliver a group message to Sunny when it is not yet subscribed and not mentioned? Determines whether the D6 bootstrap can be fully mention-free or must fall back to "first mention subscribes."
- **OQ2:** Persist `role`/`isTrusted` on the `messages` row (new columns) or derive from `senderId` + current config at read time? Deriving avoids a migration and keeps history correct if the roster changes; persisting is simpler for the dashboard. Lean: derive, persist only `isOwner` (already present).
- **OQ3:** `<id>` slug scheme for `people/<id>.md` — normalized phone/email verbatim vs a sanitized slug (filesystem-safe). Lean: filesystem-safe slug of the normalized identity, with the raw identity recorded inside the doc.
