> Build plan for the durable-subagents change. D-DS* decisions and the delegation-skill authoring spec are in this change's `design.md`.
> **Builds on `durable-main-loop` (shipped):** the store + `DurableTurnRouter` + `loadSteers` steering seam. The parent↔child channel is a store write drained by the recipient's run via `loadSteers` (+ a supervisor-started run when idle) — NOT `resumeHook`.

## 1. Unified durable-run shell (D-DS11)
- [ ] 1.1 Extract the shared `WorkflowAgent` shell into `runAgent(profile)`: `profile = {threadId (inbox), instructionsBuilder, tools, model, providerOptions, output_target, finalize}`; one `agent.stream` body with `loadSteers` in `prepareStep` and the stream-bridge/telemetry-off boilerplate factored in once
- [ ] 1.2 Define the `finalize` strategy parameterized by `recoverOnMiss ∈ {model, rawtext, none}` (D-DS14); the conversation profile uses `model` (delivery-classification + recovery backstop + turn-record persistence — unchanged behavior), jobs use `rawtext`, silent uses `none`
- [ ] 1.3 Re-express `conversation.ts` as the conversation profile of `runAgent` (perpetual run-supply; full tools; `output_target=user`; `recoverOnMiss: model`) with behavior identical to today
- [x] 1.4 Re-express `job.ts` (`runJob`) as the background-job profile (single run; host tools; `output_target=user`; `recoverOnMiss: rawtext`) — delete its bespoke `deliver()` (now the backstop branch of the shared finalize)
- [x] 1.5 Re-express `scheduledJob.ts` (`runScheduledJob`) as the scheduled-job profile (single run; memory tools; `recoverOnMiss: rawtext`); anti-recursion (D-SC4) preserved by the profile toolset

## 2. Configurable output target + the single emit path (D-DS1/12/14)
- [ ] 2.1 `output_target ∈ {user, parent, silent}` on the run profile; resolve to `{transport, destThreadId}`: `user`→`(gateway, ownerThread)`, `parent`→`(appendInbound+supervisor, parentInbox)`, `silent`→none
- [x] 2.2 Single `emit(text) → route(output_target)` step (`workflows/runShell.ts` `emitStep`); `send_message.execute` and the finalize backstop both call it (no separate `deliver`); invisible at the tool surface (no `target` arg)
- [ ] 2.3 Record-always ⟂ emit-by-target: every run persists its turn record to its own inbox thread regardless of `output_target`; `silent` profiles omit the `send_message` tool entirely
- [x] 2.4 Set the nightly memory-consolidation schedule to `output_target=silent` (stop the 2am text); default scheduled/promoted jobs remain `user` — verify result still recorded

## 3. Run-supply policy: generalize the router into the supervisor (D-DS13)
- [ ] 3.1 Generalize `DurableTurnRouter` into the delegation supervisor: a registry of `thread → {profile, run-supply policy ∈ {perpetual, single}}`; owner/group threads = perpetual, jobs/children = single
- [ ] 3.2 Each trigger registers a thread + asks the supervisor to supply run(s): gateway inbound → owner (perpetual); `cron tick` → scheduled (single); `start_job` → background (single); `delegate_task` → child (single)
- [ ] 3.3 Wire the supervisor so a `'use step'` can nudge it for a thread (it is a bootstrap-closure local today, reachable only via `gateway.onInbound`) — decide: expose on the runtime singleton, or model the parent↔child channel as an internal gateway whose `appendInbound` flows through the existing `onInbound → route` path (see design — favor the internal-gateway option for fidelity)

## 4. Configurable model per run (D-DS9)
- [ ] 4.1 Add a `model` (+ providerOptions) parameter to the run profile; default to the main thread's model when unset; jobs no longer hardcode `claude-opus-4-8`

## 5. Non-blocking delegation + durable link (D-DS2)
- [ ] 5.1 `delegate_task(brief, {tools, model, output_target:"parent", ...})`: register a child thread + start a single child run on the shared shell; return the `childId` handle immediately; the parent turn ends without blocking
- [ ] 5.2 Durable parent↔child link store (Postgres; none exists today): `parentRunId`/`parentInboxThreadId`, `childId`, `childRunId`, `childInboxThreadId`, `status`, `output_target`, `depth`; survives restart
- [ ] 5.3 Ensure child intermediate work never enters the parent context (only what the child emits to the parent inbox reaches it)

## 6. Bidirectional async messaging over the store + `loadSteers` seam (D-DS3/4)
- [ ] 6.1 Child→parent: `send_message` with `output_target="parent"` → `appendInbound(parentInbox, {from: childId, text, final?})` (a `'use step'`) + nudge the supervisor
- [ ] 6.2 Parent→child: `message_subagent(childId, text)` tool → `appendInbound(childInbox, {from:"parent", text})` + nudge
- [ ] 6.3 Recipient folds via `loadSteers` in `prepareStep` with sender-name prefix (reuse `steerMessageText`) when in-flight; when idle, the supervisor starts a fresh recipient run that drains the inbox
- [ ] 6.4 "Await == async" (D-DS3): a parent that delegated and ended its turn is restarted by the supervisor when the child's report lands as unanswered inbound — verify no keep-alive/hook involved
- [ ] 6.5 On a `final` child report, terminate the child and clean up its link (D-DS7 run-to-completion lifecycle)

## 7. Terminal-failure watchdog = the supervisor's `await` (D-DS6)
- [ ] 7.1 The supervisor `await`s each child run's `returnValue`; on terminal failure or budget exhaustion its catch/timeout branch writes `child_failed`/`child_timeout` to the parent inbox + nudges (no separate poller)
- [ ] 7.2 Parent-side handling of failure events (retry / drop-and-continue / inform owner)

## 8. Least-privilege + bounds + observability (D-DS5/8/10)
- [ ] 8.1 Enforce child toolset/credentials ⊆ parent's, through the same gating/tiers/blocklist (`security-permissions`, `tool-access`); the profile toolset is the enforcement point
- [ ] 8.2 Bounds: concurrency cap (default 3), depth cap (default 2, tracked via the link store's `depth`), no sub-delegation unless orchestrator; per-child token/time budget feeding the D-DS6 watchdog
- [ ] 8.3 Untrusted-content path: helper/preset to spawn a no-credential, no-high-consequence-tool child
- [ ] 8.4 Child runs appear as parent-associated runs/steps in the WDK runs inspector; external trajectory telemetry stays off under v7 (D-DS10) — inherit the parent's posture

## 9. Delegation skill (proposal: delegation skill; design.md "Delegation Skill — authoring spec")
- [ ] 9.1 Author the delegation skill file from the authoring spec in `design.md` (§1 when-to/not-to delegate + interdependence principle; §2 four-part task brief; §3 output-target selection; §4 model selection; §5 patterns: delegate-and-await, fan-out→synthesize, verifier/critic, research, untrusted-content containment, evaluator-optimizer, routing; §6 structured returns; §7 bounds & safety; §8 bidirectional-comms usage; §9 anti-patterns)
- [ ] 9.2 Register/index the skill so Sunny can discover it; cross-link to memory and to `security-permissions` for the untrusted-content pattern

## 10. Verification
- [ ] 10.1 Shell parity: each profile (conversation, background, scheduled) behaves identically to today after the refactor — conversation keeps delivery-classification + recovery backstop + turn-record persistence
- [ ] 10.2 `silent` job sends nothing on completion (no 2am text); result still recorded to its own thread
- [ ] 10.3 A background job is steerable in-flight via its own inbox without the steer bleeding into the owner conversation (D-DS12)
- [ ] 10.4 Delegation returns a handle without blocking; parent ends its turn; child intermediate work absent from parent context
- [ ] 10.5 Child→parent report restarts/folds into the parent without polling or a hook; parent→child steer folds into a running child via `loadSteers`
- [ ] 10.6 Child cannot exceed parent tools/credentials; untrusted-content child has none
- [ ] 10.7 Concurrency/depth caps enforced; non-orchestrator child cannot delegate
- [ ] 10.8 Terminal child failure/timeout surfaces to the parent via the supervisor's `await`
- [ ] 10.9 Child runs visible in the inspector, associated with the parent
