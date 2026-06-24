## 1. Extract shared turn logic

- [ ] 1.1 Pull prompt assembly (system prompt + skill index + memory core, with the byte-stable ephemeral cache breakpoint) out of `src/agent/loop.ts` into a helper usable by both the in-process loop and a workflow
- [ ] 1.2 Extract delivery classification + recovery (`classifyDelivery`, recovery pass, `stay_silent`, scratch/sends extraction) and one-row-per-turn persistence (`appendTurn`, D-MG9) into shared helpers
- [ ] 1.3 Extract the steer-fold logic (queue drain + group sender-name prefixing, `loop.ts:193-205`) into a reusable `prepareStep` builder that drains an injectable queue
- [ ] 1.4 Confirm in-turn tool `execute` step-wrapping is shared with `workflows/job.ts` (reuse its `'use step'` seams for bash/file_read/memory/schedule/credential)

## 2. Per-thread conversational workflow

- [ ] 2.1 Add a `DurableAgent`-based conversational workflow (`workflows/`) that builds the agent from the shared prompt/tools and runs `while (true) { agent.stream(...); await hook }`, one run per thread
- [ ] 2.2 Wire the non-blocking steer hook: `hook.then(e => queue.push(e))` plus `prepareStep` draining the queue (from task 1.3)
- [ ] 2.3 Implement `send_message` as a `'use step'` REST send by threadId via `adapter.postMessage`, memoized so a replay does not re-send
- [ ] 2.4 Preserve the D-MG8 output model inside the workflow: send_message-only voice, delivery-recovery pass, `stay_silent`; persist one enriched UIMessage row per turn (D-MG9)
- [ ] 2.5 Pass `getWritable<UIMessageChunk>()` for the run output stream and `experimental_telemetry` with the per-thread `langfuseSessionId` grouping preserved

## 3. Gateway integration

- [ ] 3.1 On inbound webhook: persist-on-arrival + retry dedup, then start the thread's run (first message) or `resumeHook(runId, event)` (subsequent/steer)
- [ ] 3.2 Track per-thread runId so the gateway can route steers and rebind after a run terminates (restart the run on next inbound if its run is gone)
- [ ] 3.3 Tail the run's output stream from the gateway and re-fire `startTyping` on each chunk, clearing when the stream closes (typing refresh; uses the live `Thread` handle)
- [ ] 3.4 Gate the new path behind a config/env flag with the existing in-process loop as default

## 4. Retire in-process durability machinery

- [ ] 4.1 Once durable path is proven, remove/disable `TurnDispatcher` per-thread serialization and in-memory steer queue (superseded by the per-thread run)
- [ ] 4.2 Remove/disable the in-process D-DE1 restart-recovery pass in `src/runtime.ts` (superseded by workflow resumption); keep gateway inbound persistence

## 5. Verification

- [ ] 5.1 Integration test: crash mid-turn resumes from last durable step and delivers exactly one outbound (no double-send on replay)
- [ ] 5.2 Integration test: steer message folds into an in-flight run at the next step; a steer arriving with no pending step starts the next turn on the same run
- [ ] 5.3 Integration test: idempotent inbound (webhook retry) processed once
- [ ] 5.4 Verify a Tier-1 turn appears in `npx workflow inspect runs --web` with per-step trace
- [ ] 5.5 Verify typing indicator refreshes across a multi-step turn and clears on completion
- [ ] 5.6 Verify no regression: Langfuse per-thread session grouping intact, prompt-cache hits unchanged (`cachedIn`/`cacheWriteIn`), adaptive thinking preserved
- [ ] 5.7 Benchmark turn latency before/after; if per-step overhead is unacceptable, fall back to the thin per-turn shell documented in design

## 6. Cutover

- [ ] 6.1 Flip the flag to durable Tier 1 as default; document rollback (flip flag back — both paths share extracted helpers, no data migration)
