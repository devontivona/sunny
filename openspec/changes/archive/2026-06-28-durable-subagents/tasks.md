> Build plan for the durable-subagents change. D-DS* decisions and the delegation-skill authoring spec are in this change's `design.md`.
> **Builds on `durable-main-loop` (shipped):** the store + `DurableTurnRouter` + `loadSteers` steering seam. The parent↔child channel is a store write drained by the recipient's run via `loadSteers` (+ a supervisor-started run when idle) — NOT `resumeHook`.

> **Implementation status (2026-06-28).** The headline capabilities are implemented + verified against a real WDK Local World: `output_target` with the `silent` 2am fix, the single `emitStep`, the parent↔child channel, the delegation supervisor (caps + watchdog), `delegate_task`/`message_subagent`, the least-privilege child, and the delegation skill. The "unified shell" landed as **shared shell *pieces*** (`workflows/runShell.ts`: `emitStep`, `loadSteersStep`, `markAnsweredStep`) called by thin per-trigger workflow entrypoints — WDK requires distinct `'use workflow'` entrypoints, so a single `runAgent(profile)` function isn't literally possible; the substance (one emit path, shared steering, profile config) is realized. Deliberately deferred (noted below): re-expressing `conversation.ts`'s stream boilerplate onto the shared pieces (1.1–1.3 — works as-is, internal cleanup only), full record-always for jobs + background-job steerability (2.3/10.3 — the design flagged background-job steering as a latent affordance, not v1 scope), and a programmatic toolset-subset check (8.1 — preset-based for v1, since the only parent today, Sunny, has full tools).

## 1. Unified durable-run shell (D-DS11)
- [x] 1.1 Shared shell extracted to `workflows/runShell.ts` `streamAgent` (WorkflowAgent construction + the `getWritable`/`stopWhen`/telemetry-off wiring + the `loadSteers` steering fold) plus shared `emitStep`/`loadSteersStep`/`markAnsweredStep`/`finalAssistantText`/`bashStep`/`fileReadStep`. All four entrypoints (conversation/job/scheduled/subagent) now call `streamAgent` — a single `'use workflow'` function isn't possible (WDK needs distinct entrypoints), so "one shell" is these shared helpers called by thin entrypoints. Net −106 lines across `workflows/`, verified behavior-identical (13 workflow tests green).
- [x] 1.2 `recoverOnMiss` realized per profile: jobs/subagent emit final text (`rawtext` via shared `finalAssistantText`), the conversation keeps its `model` recovery backstop, `silent` emits nothing. Each entrypoint's finalize is now a thin wrapper over the shared `streamAgent` result.
- [ ] 1.3 Route `conversation.ts`'s `sendStep` through `emitStep` (it is still a local gateway send; functionally identical to `emitStep` with `user`). **Deferred** — works as-is; would touch the recovery-backstop send path for no behavior change.
- [x] 1.4 Re-express `job.ts` (`runJob`) as the background-job profile (single run; host tools; `output_target=user`; `recoverOnMiss: rawtext`) — `deliver()` deleted, now `emitStep`
- [x] 1.5 Re-express `scheduledJob.ts` (`runScheduledJob`) as the scheduled-job profile (single run; memory tools; `recoverOnMiss: rawtext`); anti-recursion (D-SC4) preserved by the profile toolset

## 2. Configurable output target + the single emit path (D-DS1/12/14)
- [x] 2.1 `output_target ∈ {user, parent, silent}` (`src/agent/outputTarget.ts`) resolving to `{transport, destThreadId}`: `user`→gateway, `parent`→`appendInbound`+wake, `silent`→none
- [x] 2.2 Single `emit(text) → route(output_target)` step (`workflows/runShell.ts` `emitStep`); the finalize backstop + the child `send_message` both call it (no separate `deliver`); invisible at the tool surface
- [~] 2.3 Record-always ⟂ emit-by-target: `silent` records via `recordRun` (scheduled) / gateway-persist (user jobs); children persist their report to the parent thread. **Deferred:** a uniform "every run appends a turn record to its OWN inbox thread" for jobs.
- [x] 2.4 Nightly memory-consolidation schedule set `output_target=silent` (stops the 2am text); default scheduled/promoted jobs remain `user`; result still recorded — verified

## 3. Run-supply policy: generalize the router into the supervisor (D-DS13)
- [x] 3.1 Run-supply policy realized as two engines: `DurableTurnRouter` = perpetual (owner/group threads), `DelegationSupervisor` = single-run (children). (Kept as siblings rather than one registry class — same policy distinction, less churn on the shipped router.)
- [x] 3.2 Triggers: gateway inbound → router (perpetual); `start_job` → `runJob` (single); `cron` → `runScheduledJob` (single); `delegate_task` → supervisor → `runSubagent` (single)
- [x] 3.3 Supervisor reachable from a `'use step'` via the runtime singleton (`runtime.spawnChild`/`steerChild`/`wakeThread`); `router.wake()` drives the parent thread (chose the runtime-seam option)

## 4. Configurable model per run (D-DS9)
- [x] 4.1 `model` parameter on job/scheduled/subagent (test-aware `buildTurnModel` seam); jobs no longer hardcode `claude-opus-4-8`; children default to `claude-sonnet-4-6`

## 5. Non-blocking delegation + durable link (D-DS2)
- [x] 5.1 `delegate_task(task, label?, toolset?)`: supervisor starts a single child run, returns the child id immediately; parent never blocks
- [x] 5.2 Durable `subagent_links` table (migration 0008): `parentThreadId`, `childThreadId`, `childRunId`, `status`, `depth`, `orchestrator`, `model`; survives restart
- [x] 5.3 Child runs in its own context/inbox; only what it emits reaches the parent (verified: parent context untouched by child tool calls)

## 6. Bidirectional async messaging over the store + `loadSteers` seam (D-DS3/4)
- [x] 6.1 Child→parent: `emitStep` (`output_target=parent`) → `appendInterRunMessage(parentInbox)` + `wakeThread` (no `resumeHook`)
- [x] 6.2 Parent→child: `message_subagent(child, text)` → `steerChild` → append to the child inbox
- [x] 6.3 Recipient folds via `loadSteers` in `prepareStep` with sender-name prefix (`steerMessageText`); idle parent restarted by `router.wake`
- [x] 6.4 "Await == async": a child report wakes the parent's run-supply (verified `wakeThread(parentThread)`); no keep-alive/hook
- [x] 6.5 On completion the child reports + closes its link (`completeLink('done')`) — run-to-completion (D-DS7)

## 7. Terminal-failure watchdog = the supervisor's `await` (D-DS6)
- [x] 7.1 Supervisor `await`s the child `returnValue`; its catch branch marks the link `failed` + delivers a failure event to the parent inbox + wakes it (verified)
- [x] 7.2 Parent-side handling: the failure event lands in the thread; Sunny decides retry/drop/inform per the delegation skill (§4)

## 8. Least-privilege + bounds + observability (D-DS5/8/10)
- [~] 8.1 Least-privilege via toolset presets (`host`/`readonly`/`memory`/`none`); credential reach rides the existing bash whitelist. **Deferred:** a programmatic `child ⊆ parent` subset check (moot for v1 — the only parent, Sunny, has full tools; children are always a subset).
- [x] 8.2 Bounds: concurrency cap (3) + depth cap (2, via link `depth`) + no sub-delegation (non-orchestrator children have no `delegate_task`) — enforced in the supervisor, unit-tested
- [x] 8.3 Untrusted-content preset: `toolset:'none'` → a child with only `send_message` (no host tools, no credentials)
- [x] 8.4 Child runs are WDK runs (visible in the runs inspector); external trajectory telemetry stays off under v7 (inherited posture)

## 9. Delegation skill
- [x] 9.1 `delegation` seed skill authored from the design's authoring spec (§1 interdependence; §2 four-part brief; §3 tools; §4 model/bounds; §5 patterns; §6 returns/comms; §7 anti-patterns)
- [x] 9.2 Registered as a seed (`SEED_SKILLS`), auto-discovered; the untrusted-content pattern cross-links the containment toolset

## 10. Verification
- [x] 10.1 Shell parity: conversation (4) + job (2) + scheduled (2) workflow tests green; conversation keeps its recovery backstop + turn record
- [x] 10.2 `silent` schedule sends nothing; result recorded — verified (`scheduledJob.workflow.test.ts`)
- [ ] 10.3 Background job steerable in-flight via its own inbox without bleed — **deferred** (background-job steering is a latent affordance, not v1 scope; children ARE steerable + tested)
- [x] 10.4 Delegation returns a handle without blocking; child intermediate work absent from the parent context — verified
- [x] 10.5 Child→parent report wakes/folds the parent without poll/hook; parent→child steer lands on the child inbox — verified (`delegation.workflow.test.ts`)
- [~] 10.6 Untrusted-content child has no tools/credentials (`toolset:'none'`, verified by construction); a programmatic parent-subset check is deferred (8.1)
- [x] 10.7 Concurrency/depth caps enforced; non-orchestrator child cannot delegate — unit-tested (`delegationSupervisor.integration.test.ts`)
- [x] 10.8 Terminal child failure surfaces to the parent via the supervisor's `await` — unit-tested
- [~] 10.9 Child runs are WDK runs (inspector-visible by construction); no dedicated inspector assertion test
