# Design: Unify Background Work

## Context

Two conversation-initiated async paths exist: `start_job` → `runJob` (Tier-2 job: bash/file_read tools, Opus default, final text delivered DIRECTLY to the user thread via the bus) and `delegate_task` → `runSubagent` (supervisor-spawned child: capped, steerable, watchdogged, visible in `list_runs`, final text delivered to the PARENT thread as inbound, where a normal Sunny turn summarizes it). The 2026-07-05 incident (a 7k markdown report dumped raw into iMessage, minutes after Sunny itself confused the two primitives) showed the split's only remaining distinction — unmediated direct delivery — is a defect, not a feature. `runScheduledJob` shares `runJob`'s engine and is out of scope (no live conversation to mediate).

## Goals / Non-Goals

**Goals:**
- One primitive for conversation-initiated background work: `delegate_task`.
- Background results reach the user only through a mediating Sunny turn (voice, context, memory, possible silence).
- Delete the `start_job` machinery end to end (tool, spec, step, eval seam, catalog entry, prompt mention).
- Keep `runJob` + `buildJobPrompt` as the scheduled-run engine, doc-comments corrected.

**Non-Goals:**
- Scheduled runs (correct as-is).
- Extending delegation to group threads (explicit follow-up; groups lose background promotion for now).
- Child model/caps tuning (`delegate_task` already exposes a `model` override; the supervisor cap stays 3).
- Removing the Jobs dashboard page (still renders scheduled runs).

## Decisions

- **D1. Mediation is mandatory for conversational async work.** The extra Sonnet turn per completed task is the summarization step the product requires (same one-voice thesis as PRs #31–#35); its cost is cents. No "fast path" survives.
- **D2. Guidance moves, not just the tool.** `start_job`'s description carried the load-bearing anti-inline-grinding instruction (added after the 23-curl-calls incident). It moves into `DELEGATE_TASK_SPEC`'s description nearly verbatim, plus "your reply just says you're on it; the result comes back to this conversation."
- **D3. Prompt reference.** `howYouSpeakText`'s dangling-promise guard says "use start_job instead" — becomes "delegate it instead" (tool-mode text is gone, so this is the only prompt mention).
- **D4. Eval surface shrinks honestly.** `Trajectory.startJobs` and the `startedJob` grader are deleted; `backgroundedLongTask` becomes delegation-only (its bash-grind guard unchanged); the `stubJobs` runtime seam is deleted (nothing can start a job from a turn anymore — delegation already has its own inert-when-absent `spawnChild` seam).
- **D5. `runJob` keeps its shape.** `JobInput`, the Opus default, and direct thread delivery are all still correct for the scheduler; only the "promoted via start_job" doc framing changes. (Whether scheduled runs should move off Opus is a separate question for the model-trial follow-up.)

## Risks / Trade-offs

- **[Group regression] groups lose background promotion** → accepted deliberately; the alternative (group delegation) needs its own authority-model thinking. The turn can still do quick inline work in groups.
- **[Double work] the mediating turn might re-do the child's task instead of summarizing** → the child's report arrives attributed (`label (subagent): …`) and the delegation-result framing already exists in production behavior; watch the first few real promotions.
- **[Concurrency cap] 3 concurrent children now bounds ALL background work** → previously jobs were unbounded (a defect dressed as capacity); if the cap chafes, raising it is a one-line supervisor change.
- **[In-flight jobs at deploy] a running `runJob` from an old turn** → unaffected; `runJob` still exists and completes normally.
