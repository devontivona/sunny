> Build plan for the **run-audiences** change. D-RA* decisions are in this change's `design.md`.
> Phase 1 unblocks the self-scheduling regression fast; Phase 2 introduces the model; Phase 3
> adds detached threads + household runs. Ship Phase 1 on its own if desired.

## Phase 1 — Unblock the regression (family-correct, minimal)
- [ ] 1.1 Re-register `schedule_create` / `schedule_list` / `schedule_delete` in `workflows/conversation.ts` `buildTools`, gated to trusted DMs (owner **or** family), not owner-only (D-RA8, D-RA11).
- [ ] 1.2 Make a scheduled run **audience-aware**: derive prompt framing + delivery from the schedule's principal/audience instead of the hardcoded owner (`buildJobPrompt` no longer says "for Devon"); a schedule created by Kate delivers to Kate (D-RA4, D-RA7).
- [ ] 1.3 Re-wire `ensureConsolidationSchedule` (currently defined-but-never-called) so fresh installs seed nightly consolidation, as a `household` singleton endowed no messaging grant (structurally silent) over the shared core — drop the "review the recent conversation" framing (D-RA2, D-RA10, D-RA14).
- [ ] 1.4 Fix the dashboard tool catalog: stop referencing the deleted `loop.ts`; surface exactly the tools the durable turn registers (D-RA8).
- [ ] 1.5 Regression test: a family member's DM turn can create a schedule; the fired run addresses that member and delivers to their thread; a scheduled run cannot self-schedule (attenuation, task 2.4).

## Phase 2 — The model: Audience / Thread / Principal / authority
- [ ] 2.1 Define `Audience` (`person | household | thread | parent`), `Principal`, and `authority` (a grant set) as node-free types alongside `outputTarget.ts`; add `resolveAudience(audience) → { instructions, contextDocs, deliver, tools }` as a durable step (D-RA1, D-RA2, D-RA7).
- [ ] 2.2 Replace the `user`/`parent`/`silent` **output target** with an Audience + tool-driven delivery end-to-end (`emitStep`, the four workflow entrypoints, `src/agent/outputTarget.ts`): `parent`→`parent(...)`; drop the `silent` mode and the job/scheduled terminal auto-emit (`rawtext`) — silence becomes "no messaging grant" (D-RA2, D-RA14); apply the existing recovery backstop to any run holding a messaging grant — modifies durable-execution "Configurable output target".
- [ ] 2.3 Collapse the four `buildSetup`s toward one RunSpec-driven assembler; framing derived from audience/principal, reusing `setupTurn`'s participant-awareness for all profiles (D-RA7).
- [ ] 2.4 Authority attenuation: construct each spawned run with a **subset** `tools` set endowed explicitly at spawn (no ambient authority), assert `⊆ creator` at spawn, add `activeTools` in-loop narrowing; the anti-recursion guard becomes "`schedule` grant not endowed by default" + derivation-tree depth cap (D-RA5, D-RA6) — modifies durable-execution "Least-privilege child runs" and scheduling "Anti-recursion guard".
- [ ] 2.5 Storage: add `audience`, `principal`, `authority` columns to `schedules` and `subagent_links`; migrate existing rows (old `threadId`+`output_target` → `thread(threadId)` audience; existing schedules → owner principal); `start_job` passes its RunSpec inline (D-RA11).
- [ ] 2.6 Share the `{ audience, authority }` argument shape across `start_job` / `delegate_task` / `schedule_create` (promote `delegate_task`'s `toolset` into `authority`); ownership derives from principal (D-RA8, D-RA4) — modifies tool-access.

## Phase 3 — Detached threads, household runs, unified lifecycle & skill
- [ ] 3.1 First-class Thread kind: `bound` (adapter-backed) vs `detached` (channel-less), aligned to the Chat SDK `Thread`/`SerializedThread` model; back detached threads (subagent inbox, household workspace) with `@chat-adapter/state-memory`; replace hand-rolled threadId parsing (`isGroupThreadId`) with SDK channel derivation where practical (D-RA3).
- [ ] 3.2 Household runs: a `household` audience run holds roster-scoped `message_person` and may proactively text any member (each delivery resolves to that member's DM); a detached household inbox provides its steering/log (D-RA10, D-RA2).
- [ ] 3.3 Unify inspection/lifecycle into audience-agnostic `list_runs` / `cancel_run` spanning schedules + background jobs + subagents, scoped by ownership (principal + owner) (D-RA8, D-RA4) — modifies tool-access.
- [ ] 3.4 Merge the subagent-only `delegation` seed into one **delegation & scheduling** skill covering the spawn taxonomy (now/background/later · for whom · least authority); optionally filter the skill index by run authority (D-RA9) — modifies agent-skills.

## Verify
- [ ] 4.1 Scenario coverage from `design.md`: the Leo reminder (person; delivers to Kate only when it calls send_message, i.e. only if due), the follow-up sweep (household fan-out to multiple members), consolidation (household with no messaging grant → structurally silent, records only), a subagent (parent audience, authority ⊂ parent), and ownership (Kate lists/cancels her runs; owner sees all).
- [ ] 4.2 Confirm no ambient authority: a run endowed `{memory}` cannot invoke `bash` even though the tool exists in-process; a child cannot exceed its parent.
