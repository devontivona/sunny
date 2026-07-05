## Why

Sunny has two ways to run conversation-initiated background work, and the split is now doing harm. On 2026-07-05, a turn promoted a build task via `start_job`; the finished job delivered a 7,011-character markdown "Final Report" directly into the owner's iMessage — unmediated, in a register the product's terse-iMessage voice forbids. Minutes earlier, Sunny itself had mis-modeled its own architecture live ("I tried to steer that job like a subagent — let me correct myself"): the model cannot reliably distinguish the two concepts either.

Structurally, after the text-delivery unification (PRs #31–#35), a background job is a delegated subagent minus every safety and quality feature: its report bypasses the parent-turn mediation that keeps replies in voice (a subagent's report arrives as inbound on the conversation thread, and a full Sunny turn — with conversational context — summarizes it); it is not steerable; it is invisible to `list_runs` and uncancellable; it has no supervisor watchdog (a crashed job is silence forever, where a crashed child's failure is reported to the parent); it has no concurrency cap; and it still defaults to Opus 4.8 (a pre-model-trial leftover). The one thing the job path saves — the mediation turn — is exactly what produced the 7k dump. Mediation is the feature.

Scheduled runs are explicitly out of scope: a fired schedule has no live conversation waiting, so its direct terminal delivery is correct. The `runJob` workflow survives as the scheduler's engine.

## What Changes

- The conversational turn's `start_job` tool is REMOVED. Long or asynchronous work promoted from a conversation goes through `delegate_task` (an isolated subagent that reports back to the conversation thread, where a normal Sunny turn summarizes the result in voice).
- `delegate_task`'s model-facing description absorbs `start_job`'s load-bearing guidance: use it INSTEAD of grinding through long work inline (the chat is blocked while a turn works), and the turn's reply just says you're on it.
- The `start_job` machinery is deleted: `START_JOB_SPEC`, `startJobStep`, the eval `stubJobs` runtime seam, the dashboard tool-catalog entry, and the prompt's `start_job` mention (which now points at delegation).
- `runJob` (the Tier-2 workflow) and `buildJobPrompt` remain, serving scheduled runs only; their doc comments drop the "promoted from a conversational turn via start_job" framing.
- Evals: the tool-selection backgrounding case grades delegation only (its `backgroundedLongTask` grader already accepts it); the `startJobs` trajectory field and `startedJob` grader are retired.
- Group threads, which today have `start_job` but not `delegate_task` (delegation is trusted-DM-gated), lose conversation-initiated background work for now. Extending delegation to groups (with a restricted child toolset) is a deliberate follow-up decision, not smuggled into this change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `durable-execution`: the Tier-2 "promote long work from a conversation" requirement is re-scoped — conversation-initiated background work SHALL run as a delegated subagent (mediated report), and direct terminal delivery to a user thread is reserved for scheduled runs.

## Impact

- **Code**: `workflows/conversation.ts` (tool removal, `startJobStep` deletion), `src/agent/tools/startJobSpec.ts` (deleted), `src/agent/tools/delegationSpecs.ts` (description), `src/agent/tools/catalog.ts`, `src/agent/prompt.ts` (one line), `workflows/job.ts` doc comments, `evals/harness.ts` + `evals/graders.ts` + `evals/types.ts` + `evals/cases/toolSelection.ts`, workflow tests.
- **Behavior**: background results reach the user through a mediating Sunny turn (terse, in voice, context-aware) instead of raw report dumps; background work becomes steerable, listable, cancellable, capped, and watchdogged. Cost: one extra Sonnet turn per completed background task (cents; it IS the summarization step).
- **Groups**: temporarily lose background promotion (see follow-up above).
- **No config or data migration**; existing persisted job deliveries remain readable history.
