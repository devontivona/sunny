> Build plan for the durable-subagents change. D-DS* decisions and the delegation-skill authoring spec are in this change's `design.md`.
> **Depends on `durable-main-loop`** — tasks 3–5 require its durable hook-driven parent + `resumeHook`/`prepareStep` seam. Tasks 1–2 (output target, model) ride existing Tier-2 machinery and may land earlier.

## 1. Configurable output target (durable-execution R: output target; D-DS1)
- [ ] 1.1 Add `output_target ∈ {user, parent, silent}` to durable-run config; thread it through job/run creation
- [ ] 1.2 Route `send_message` by target: `user` → gateway, `parent` → spawning run, `silent` → suppress proactive output (record result only)
- [ ] 1.3 Set the nightly memory-consolidation job to `silent` (stop the 2am text); default scheduled/promoted jobs remain `user`

## 2. Configurable model per run (durable-execution R: model; D-DS9)
- [ ] 2.1 Add a `model` parameter to delegated/background run creation; default to the main thread's model when unset

## 3. Non-blocking delegation + durable link (durable-execution R: non-blocking delegation; D-DS2)
- [ ] 3.1 `delegate_task(brief, {tools, model, output_target:"parent", ...})`: start an isolated-context child durable run reusing the conversational-turn shell from `durable-main-loop`
- [ ] 3.2 Durable parent↔child link store (Postgres): `parentRunId`, `childId`, `status`, `output_target`; survives restart
- [ ] 3.3 Return the child handle immediately; do not block the parent; ensure child intermediate work never enters the parent context

## 4. Bidirectional async messaging (durable-execution R: bidirectional messaging; D-DS3/4)
- [ ] 4.1 Child→parent: `send_message` with `output_target="parent"` → `resumeHook(parentRun, {from: childId, text, final?})`
- [ ] 4.2 Parent→child: `message_subagent(childId, text)` tool → `resumeHook(childRun, {from:"parent", text})`
- [ ] 4.3 Fold child/parent messages in the recipient's `prepareStep` with sender-name prefixing (reuse the conversational-turn group-sender logic)
- [ ] 4.4 On a `final` child report, terminate the child and clean up its link (D-DS7 run-to-completion lifecycle)

## 5. Terminal-failure watchdog (durable-execution R: terminal failure; D-DS6)
- [ ] 5.1 Runtime watcher emits `child_failed`/`child_timeout` to the parent on terminal child failure or budget exhaustion
- [ ] 5.2 Parent-side handling of failure events (retry / drop-and-continue / inform owner)

## 6. Least-privilege + bounds + observability (durable-execution R: least-privilege, bounded, observable; D-DS5/8/10)
- [ ] 6.1 Enforce child toolset/credentials ⊆ parent's, through the same gating/tiers/blocklist (`security-permissions`, `tool-access`)
- [ ] 6.2 Bounds: concurrency cap (default 3), depth cap (default 2), no sub-delegation unless orchestrator; per-child token/time budget
- [ ] 6.3 Untrusted-content path: helper/preset to spawn a no-credential, no-high-consequence-tool child
- [ ] 6.4 Child runs appear as parent-associated runs/spans in the inspector + trajectory telemetry

## 7. Delegation skill (proposal: delegation skill; design.md "Delegation Skill — authoring spec")
- [ ] 7.1 Author the delegation skill file from the authoring spec in `design.md` (§1 when-to/not-to delegate + interdependence principle; §2 four-part task brief; §3 output-target selection; §4 model selection; §5 patterns: delegate-and-await, fan-out→synthesize, verifier/critic, research, untrusted-content containment, evaluator-optimizer, routing; §6 structured returns; §7 bounds & safety; §8 bidirectional-comms usage; §9 anti-patterns)
- [ ] 7.2 Register/index the skill so Sunny can discover it; cross-link to memory and to `security-permissions` for the untrusted-content pattern

## 8. Verification
- [ ] 8.1 `silent` job sends nothing on completion (no 2am text); result still recorded
- [ ] 8.2 Delegation returns a handle without blocking; parent continues; child intermediate work absent from parent context
- [ ] 8.3 Child→parent report wakes/folds into the parent without polling; parent→child steer folds into a running child
- [ ] 8.4 Child cannot exceed parent tools/credentials; untrusted-content child has none
- [ ] 8.5 Concurrency/depth caps enforced; non-orchestrator child cannot delegate
- [ ] 8.6 Terminal child failure/timeout surfaces to the parent as an event
- [ ] 8.7 Child runs visible in the inspector, associated with the parent
