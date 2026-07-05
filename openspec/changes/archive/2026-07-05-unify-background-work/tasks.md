## 1. Tool surface

- [x] 1.1 `workflows/conversation.ts`: remove the `start_job` tool from `buildTools` and delete `startJobStep`; drop the `START_JOB_SPEC` import
- [x] 1.2 Delete `src/agent/tools/startJobSpec.ts`; `src/agent/tools/catalog.ts` drops its entry (delegation tools are trusted-DM/elevated — reflect `delegate_task`/`message` there if absent)
- [x] 1.3 `src/agent/tools/delegationSpecs.ts`: `DELEGATE_TASK_SPEC` description absorbs the anti-inline-grinding guidance ("use this INSTEAD of working through a long task inline — the chat is blocked while you work; your reply just says you're on it; the result reports back to this conversation")
- [x] 1.4 `src/agent/prompt.ts` `howYouSpeakText`: "(For genuinely long work, use start_job instead…)" → delegate wording
- [x] 1.5 `workflows/job.ts` + `src/agent/prompt.ts` `buildJobPrompt` doc comments: drop the "promoted from a conversational turn via `start_job`" framing (scheduled-run engine only)

## 2. Evals + tests

- [x] 2.1 `evals/types.ts`: remove `Trajectory.startJobs`; `evals/harness.ts`: remove the `stubJobs` runtime seam + `startJobs` assembly; `evals/graders.ts`: delete `startedJob`, make `backgroundedLongTask` delegation-only
- [x] 2.2 `evals/cases/toolSelection.ts`: the research case's comment/graders reflect delegation-only backgrounding
- [x] 2.3 Workflow/unit tests referencing `start_job`/`stubJobs` updated; full suites green (`tsc`, unit, integration, workflow)

## 3. Spec + rollout

- [x] 3.1 Sync the `durable-execution` delta into the main spec (opsx:sync guidelines) and archive this change
- [ ] 3.2 Deploy (devbox restart) and live-verify: a promoted long task runs as a child, its report is mediated by a turn (terse reply, no raw dump)
