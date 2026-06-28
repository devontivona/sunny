## 1. Foundation — trust tiers & roster (shared by both phases)

- [x] 1.1 Add a `family` roster to the config schema in `src/config/index.ts` (`family: [{ name, identities[] }]`, default `[]`), mirroring `owner`; update the config default/sample and `config.unit.test.ts`.
- [x] 1.2 Extend `AuthResult` in `src/gateway/auth.ts` to `{ authorized, isTrusted, isOwner, role }` (`role: 'owner' | 'family' | null`); keep `isOwner` meaning literal owner.
- [x] 1.3 Update `Authorizer` to build a family identity set (reusing `normalize()`) and resolve sender → role/`isTrusted`; keep owner resolution unchanged.
- [x] 1.4 Add unit tests in `auth.unit.test.ts`: family DM → trusted/non-owner; owner → trusted/owner; unknown → not authorized; formatting-tolerant matching for family identities.
- [x] 1.5 Thread `role`/`isTrusted` onto the normalized `ChannelEvent` (`src/gateway/types.ts`) and decide persistence per design OQ2 (lean: derive role at read time, persist only existing `isOwner`); adjust `src/gateway/store.ts` reconstruction accordingly.

## 2. Phase 1 — Family DMs

- [x] 2.1 In `src/gateway/sendblue.ts` `dispatch()`, replace the binary authorize call with the tiered `authorize(...)`; authorize family DMs (currently rejected) and keep rejecting non-trusted DMs.
- [x] 2.2 Flip capability gating in `workflows/conversation.ts` `buildTools(...)` from `ownerDm = !isGroup` to `isTrusted`; preserve the owner's current DM behavior exactly.
- [x] 2.3 Keep owner-only capabilities gated on `isOwner` (carve-out): editing the owner's `USER.md` is owner-only; structure the gate so more carve-outs are easy to add later.
- [x] 2.4 Unit-test the tier→toolset mapping: family DM gets the elevated set (`bash`/`file_read`/`delegate_task`/`message_subagent`); non-trusted gets none; owner unchanged.

## 3. Phase 1 — Per-person profile docs

- [x] 3.1 Add a stable `<id>` slug derivation from a normalized identity (filesystem-safe; raw identity recorded inside the doc) — design OQ3.
- [x] 3.2 Extend `src/memory/index.ts` with a `people/<id>.md` path scheme: lazy auto-create on first contact, load by id, seeded header template (mirroring `USER.md` seeding).
- [x] 3.3 Update context assembly (`src/agent/instructions.ts` / `src/agent/prompt.ts`) to load the profile docs of the trusted participants present in the current thread, in addition to the always-on owner `USER.md` + `SUNNY.md` + `INDEX.md`.
- [x] 3.4 Route `memory_write` targets (`src/agent/tools/memorySpecs.ts` + `workflows/conversation.ts` memWriteStep): owner-facts → `USER.md` (owner only), person-facts → that person's `people/<id>.md`, operating notes → `SUNNY.md`; reject non-owner writes to `USER.md`.
- [x] 3.5 Author the cross-person discretion guidance as a skill (and/or `SUNNY.md` operating note), not in the cached system prompt (D7): use judgment about disclosing one person's facts to another; owner profile stays loaded, not siloed. Keep the always-on prefix byte-stable.
- [x] 3.6 Tests: auto-create on first family contact; person-fact routes to the person's doc and not `USER.md`; non-owner cannot edit `USER.md`; present-participant doc is loaded.

## 4. Phase 2 — Family group authorization

- [x] 4.1 Add a roster fetch in the group path (`thread.getParticipants()` / Sendblue adapter `participants`) and an all-trusted membership check; owner need not be present.
- [x] 4.2 In `dispatch()`/group handlers, authorize a group only if every participant is trusted; one outsider → silence the whole group; re-check on every message; fail closed if the roster is unavailable.
- [x] 4.3 Tests: all-trusted group authorized; one outsider silences the group; family-only (no owner) group authorized; outsider added mid-thread silences on next message; roster fetch failure → fail closed.

## 5. Phase 2 — Group participation without @mention

- [x] 5.1 Implement the subscription bootstrap in `src/gateway/sendblue.ts` group handlers: on a delivered group message, run the authorization check and `subscribe()` if authorized, then deliver to the agent without requiring an `@mention`.
- [x] 5.2 Resolve design OQ1 — verify whether Sendblue delivers a not-yet-subscribed, non-mentioned group message; if a mention is required to bootstrap, document the fallback ("first mention subscribes, discretion thereafter").
- [x] 5.3 Confirm passive-assistant discretion uses the existing `stay_silent`/`send_message` machinery (no new participation primitive); verify group attribution prefixes still render for multiple family speakers. Author the group-etiquette guidance (when to chime in vs stay silent) as a skill/operating note, not hardcoded (D7).
- [x] 5.4 Confirm group tool exposure is unchanged from current behavior (no expansion of host-affecting tools in groups for this change).

## 6. Behavioral skill/operating-notes (per D7)

- [x] 6.0 Capture the family-behavior guidance as skill content / `SUNNY.md` notes (cross-person discretion, per-person doc curation, family-group etiquette, family-vs-owner relating). Verify enforcement (auth, gating, membership, write-routing) remains in code and is NOT relocated into any skill.

## 6b. Cross-thread recall (added after live testing)

- [x] 6b.1 Make `recall_history` cross-thread + attributed: thread the config into `execRecall`, label each hit by conversation (owner/family roster), update the tool description and the memory-section prompt guidance to say it spans all conversations and to use discretion.
- [x] 6b.2 Tests: cross-thread recall attributes DM hits by roster name and groups generically.

## 6c. Relayed sends to roster members (added after live testing)

- [x] 6c.1 Add `message_person` (roster-only): a trusted-DM tool that resolves a recipient against the owner/family roster, addresses their existing DM thread (or constructs a Sendblue DM id), and proactively sends + persists into that thread. Refuses non-roster recipients. Memoized step (no double-send on replay).
- [x] 6c.2 Tests: relay lands on the recipient's thread + confirms on the current one; non-roster recipient is refused with no send.
- [x] 6c.3 Add optional `image` to `message_person` (local path or URL), mirroring `send_message`: `messagePersonStep` passes it as `gateway.send`'s `attachment` (hosted/persisted, group-degraded by the gateway). Test: an image relay carries the attachment to the recipient's thread.

## 7. Verification & wiring

- [x] 7.1 Run the full unit/integration suite; update any tests asserting the old binary authorize/`ownerDm` gating.
- [ ] 7.2 Manual end-to-end check: a configured family member DMs Sunny (Phase 1) and a family-only group (Phase 2); confirm authorization, per-person doc creation/loading, elevated tools in DM, and outsider-silencing in groups.
- [x] 7.3 Update README/config sample to document the `family` roster and the accepted trust boundary (identity == phone/email; full lockdown deferred to `security-permissions`).
