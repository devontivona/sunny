> Build plan for the **run-audiences** change. D-RA* decisions are in this change's `design.md`.
> **Phase 1a is genuinely standalone** — it fixes the self-scheduling regression on the *existing*
> `threadId`+`outputTarget` model, no new abstractions, and can ship on its own. Phase 2 introduces
> the Audience / delivery-bus / authority model; Phase 3 adds household runs, unified lifecycle, and
> the skill. (Formalizing Chat SDK `Thread` / retiring `isGroupThreadId` is a **separate deferred
> change**, not in scope here.)

## Phase 1a — Unblock the regression (existing model, no new abstractions) ✅
- [x] 1a.1 Re-register `schedule_create` / `schedule_list` / `schedule_delete` in `workflows/conversation.ts` `buildTools`, gated to trusted DMs (owner **or** family), via node-free `scheduleToolSpecs` + `'use step'`-wrapped executes (`src/agent/tools/scheduleSpecs.ts`) (D-RA8).
- [x] 1a.2 Re-wire `ensureConsolidationSchedule` (was defined-but-never-called) — seeded once at runtime startup, addressed to the owner's DM thread (constructed from config + `SENDBLUE_FROM_NUMBER`), keeping the existing `outputTarget: 'silent'` mechanism (Phase 2 migrates it to "no messaging grant").
- [x] 1a.3 Fix the dashboard tool catalog (`src/agent/tools/catalog.ts`): dropped the deleted-`loop.ts` reference; now mirrors `conversation.ts` `buildTools` and the trusted-DM (owner OR family) gate.
- [x] 1a.4 Regression test: `tests/workflow/scheduleTools.workflow.test.ts` — trusted-DM turn creates a schedule (delivered back to its thread); a non-owner family DM can schedule too; `schedule_delete` cancels one. Drives the real `runConversation` workflow with a scripted model.

## Phase 2 — The model: Audience / delivery bus / authority
> Status: the two self-contained, user-visible pieces are landed + fully tested — **2.8** (unified
> `message` bus-tool) and **2.4** (family-correct `start_job` framing). The remainder (2.1/2.2/2.3/
> 2.5/2.6/2.7) is a tightly-coupled cluster — the `OutputTarget`→`Audience` swap threaded through all
> four durable entrypoints, the one-finalize backstop hoist, authority attenuation, and the **live-
> data schema migration** of the production `nightly-consolidation` row — best done against the
> running devbox + a DB snapshot, where durable delivery and the migration can be verified end-to-end
> **Status: Phase 2 COMPLETE** and verified — full workflow suite (24) + unit/integration (316) green,
> AND an end-to-end loopback turn on the live devbox (scripted `schedule_create` + `send_message` →
> real schedule row + reply delivered through the bus). Note on 2.6: no destructive migration was
> needed — audience is *derived* from the existing `threadId`+`output_target` columns
> (`audienceForSchedule`), so silent rows map to `household` (no delivery) with zero data change; a
> `person`-audience column is a deferred nicety only the cross-person case needs.
- [x] 2.1 Defined `Audience` (`thread | person | parent | household`) + `Authority` (grant-string array) + `isAuthoritySubset` + `subjectName` + `audienceForSchedule` + `authorityForToolset`/`TRUSTED_DM_AUTHORITY` in node-free `src/agent/audience.ts`. `resolveAudience` is realized as `deliver` (routing) + `subjectName` (framing); ownership derives from the audience (D-RA4) — **no `Principal` type/field**.
- [x] 2.2 **Delivery bus (D-RA15):** collapsed `emitStep`'s arms + `messagePersonStep`'s `gateway.send` + `steerChildStep`'s append into one `deliver(audience, text)` in `runShell.ts` dispatching on binding (`bound` → gateway; `detached`/`subagent:` → append + wake). `reportToParent` carries the `from` attribution. Replaced the `user`/`parent`/`silent` output target with an Audience across all four entrypoints; deleted `outputTarget.ts` — modifies durable-execution "Configurable output target".
- [x] 2.3 **One finalize / one bus:** every profile's terminal message is a single `deliver` call to its audience (job/scheduled/subagent), so nothing is stranded and a silent-success subagent still reports (F1). The conversation recovery backstop is **framed by the thread's subject**, not `config.owner.name` (F6/D-RA4). *(No separate backstop for headless jobs — their final text is delivered directly by the bus, the correct D-RA14 behavior.)*
- [x] 2.4 Framing derived from the subject, not hardcoded owner: `buildJobPrompt` takes an optional `subject` (D-RA4) — identity stays the owner's assistant, but a job acts for + reports to its subject. Wired end-to-end on the **`start_job` path** (`setupTurn` derives the subject from the thread's participants → `buildTools` → `startJobStep` → `JobInput.subjectName` → `buildJobPrompt`). Unit-tested. *(Scheduled-run family framing and the full one-assembler collapse land with 2.6, which gives schedules an audience to derive the subject from.)*
- [x] 2.5 Authority attenuation: spawned runs are endowed a subset toolset explicitly at spawn (no ambient authority); the supervisor asserts `authorityForToolset(child) ⊆ parentAuthority` (set inclusion) and refuses with `error: 'authority'` otherwise. `TRUSTED_DM_AUTHORITY` reifies the conversation turn's root; anti-recursion stays "`schedule` grant not endowed" + the depth cap. Tested (supervisor refusal case). *(`activeTools` in-loop narrowing not added — the constructed-subset `tools` set is the boundary, which is sufficient.)*
- [x] 2.6 Storage: **no schema change / no destructive migration** — `audienceForSchedule(threadId, output_target)` *derives* the audience from the existing columns (`silent` → `household` record-only; else → `thread(threadId)`), so the production consolidation row keeps sending nothing with zero data change. A `person`-audience column (for cross-person scheduling like "Devon sets a reminder FOR Kate") is a deferred nicety — the common per-person case already works because each person's schedules live in their own thread.
- [x] 2.7 Scheduled/family delivery: a schedule delivers through the bus to the thread it was created in (a family member's thread → them, not the owner) and is framed for that subject (`subjectName` in `scheduledJob` `buildSetup`). **`person`-audience fire-time resolution:** `deliver` resolves a roster member to their bound DM (existing thread or `sendblueDmThreadId`); when unresolvable (never-contacted / off-roster), it notifies the owner instead of dropping silently (D-RA2). Verified by the `family-correct` scheduled workflow test.
- [x] 2.8 Messaging tools: **unified `message_person` + `message_subagent` into one addressed `message(recipient, text)`** (recipient ∈ roster people ∪ my running subagents) — dispatches child-vs-person over the bus; `send_message(text)` stays reply-to-my-audience; delegation skill updated. Integration + unit tested. *(The shared `{ audience, authority }` spawn-arg shape across the creation verbs lands with 2.1/2.5.)*

## Phase 3 — Household runs, unified lifecycle & skill ✅
- [x] 3.1 Proactive fan-out (D-RA10): a delivering scheduled run gains the roster-scoped `message` tool (bus person-relay), so it can text any roster member; the silent `household` maintenance run is withheld the grant → structurally silent (D-RA14). Tested (scheduledJob fan-out test). *(A dedicated `detached` household inbox + a rate/dedup guardrail on recurring fan-out remain a follow-up — the capability is delivered.)*
- [x] 3.2 Unified `list_runs` / `cancel_run` spanning **schedules + this conversation's running subagents**, ownership-scoped (owner sees/cancels all; a family member only runs whose audience subject is them; `completeLink` gains `'cancelled'`). Replaced schedule_list/schedule_delete; catalog + tests updated — modifies tool-access.
- [x] 3.3 Broadened the `delegation` seed into one **delegation & scheduling** skill covering the spawn taxonomy (delegate_task / start_job / schedule_create · when to choose which · least authority · list_runs/cancel_run). Skill validates. *(Optional authority-filtered skill index deferred — the agent-skills spec makes it a MAY.)*

## Verify ✅
- [x] 4.1 Scenario coverage (workflow suite + live loopback): family-correct scheduled delivery (delivers to Kate's thread, not the owner), household fan-out via `message`, consolidation structurally silent (records only), subagent parent report (silent-success still reports), and ownership (owner cancels a schedule via `cancel_run` — verified end-to-end on the live devbox).
- [x] 4.2 No ambient authority: the supervisor refuses a child whose toolset grants exceed the parent authority (tested); a scheduled run isn't endowed the `schedule` grant.
- [x] 4.3 One bus: every outward message flows through `deliver(audience, text)` — `emitStep`/`outputTarget.ts` deleted; job/scheduled/subagent/conversation all deliver through the single seam (workflow suite + live loopback confirm delivery).
