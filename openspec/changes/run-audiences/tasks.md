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

## Phase 3 — Household runs, unified lifecycle & skill
- [ ] 3.1 Household runs: a `household` audience run holds the roster-scoped `message` tool and may proactively text any member (each delivery resolves to that member's `bound` thread via the bus); a `detached` household inbox provides its steering/log (D-RA10, D-RA2). *(Follow-up, not this change: a rate/dedup guardrail on recurring proactive fan-out.)*
- [ ] 3.2 Unify inspection into `list_runs` / `cancel_run` spanning **schedules + subagents**, scoped by ownership (audience subject + owner). Background jobs (no persisted row) are out of scope until a run ledger exists — state that limit in the tool description (D-RA8, D-RA4) — modifies tool-access.
- [ ] 3.3 Merge the subagent-only `delegation` seed into one **delegation & scheduling** skill covering the spawn taxonomy (now/background/later · for whom · least authority); optionally filter the skill index by run authority (D-RA9) — modifies agent-skills.

## Verify
- [ ] 4.1 Scenario coverage from `design.md`: the Leo reminder (person; delivers to Kate via the bus only when there's something to say, i.e. only if due; and the never-contacted-person fallback surfaces to the owner), the follow-up sweep (household fan-out via `message`), consolidation (household, no messaging grant → structurally silent, records only), a subagent (parent audience; silent-*success* still reports via the bus and closes the watchdog), and ownership (Kate lists/cancels her runs; owner sees all).
- [ ] 4.2 Confirm no ambient authority: a run endowed `{memory}` cannot invoke `bash` even though the tool exists in-process; a child cannot exceed its parent.
- [ ] 4.3 Confirm one bus: every outward message (conversation reply, job/scheduled result, subagent report, household relay, child steer) flows through `deliver(thread, msg)` — no residual `emitStep`/bespoke send path.
