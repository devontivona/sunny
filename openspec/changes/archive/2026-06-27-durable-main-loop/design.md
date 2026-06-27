## Context

Sunny runs two execution tiers (D-DE: two-tier execution model). Tier 1 is the in-process conversational turn in `src/agent/loop.ts` — a Vercel AI SDK `ToolLoopAgent` that streams a turn, executes tools inline, and replies. Tier 2 is the durable background job in `workflows/job.ts` — a WDK `DurableAgent` (`@workflow/ai`) where each tool is a `'use step'`, run via `start()` on the `@workflow/world-postgres` runtime.

Only Tier 2 is visible in `npx workflow inspect runs --web` and resumable after a crash. Tier 1 — the path nearly every interaction takes — emits only Langfuse spans (`loop.ts:180`) and, on a mid-turn crash, is re-run from scratch by an in-process restart-recovery pass (`runtime.ts`, D-DE1).

Current Tier-1 wiring that this design touches:
- **Ack-fast webhook**: `dispatch()` sets a live `Thread` handle into `activeThreads` and calls the inbound handler, which returns immediately; the turn runs in the background (`sendblue.ts:191`, `dispatcher.ts:25`).
- **Per-thread serialization + steering**: `TurnDispatcher` keeps an in-process `active` map; a message arriving mid-run is pushed to an in-memory array (`dispatcher.ts:55`) and drained by the turn's `prepareStep` (`loop.ts:194`).
- **Delivery**: `send()` uses the live handle when present but already falls back to REST-by-threadId via `adapter.postMessage` (`sendblue.ts:131-136`); proactive/Tier-2 sends use exactly that path.
- **Typing**: a single `startTyping` at turn start (`loop.ts:102`), never refreshed; no-ops without a live handle (`sendblue.ts:146-155`).

Verified enabling facts (settled in prior investigation):
- `DurableAgent.stream()` exposes `prepareStep` returning a `messages` override (`@workflow/ai` `durable-agent.d.ts:502`, `:222`) — the same injection seam Tier 1 uses today.
- WDK's `message-queueing.mdx` documents the exact steering pattern: a non-blocking `hook.then(...)` listener fills an in-memory queue that `prepareStep` splice-drains; and a `while (true) { stream(); await hook }` loop for one durable run per session (`message-queueing.mdx:74-99`, `:130-168`).

## Goals / Non-Goals

**Goals:**
- Tier-1 conversational turns appear in `npx workflow inspect runs --web` with per-step traces, alongside Tier-2 jobs.
- Turns resume from their last durable step after a crash/reboot, instead of restarting.
- Retire the hand-rolled in-process durability machinery (dispatcher active-map, steer queue, D-DE1 restart-recovery) into the WDK runtime.
- Preserve the typing indicator and *improve* it (refresh across a long turn).
- Zero spec-level regression to D-MG8 (send-message-only output, recovery pass, `stay_silent`), D-MG9 (one-row-per-turn persistence), Langfuse session grouping, prompt-cache stability, and adaptive thinking.

**Non-Goals:**
- Changing the LLM, prompt content, tool surface, or the send-message output model.
- Token-streaming to the client (iMessage delivers discrete bubbles; the run stream is for observability + typing, not a UI transport).
- Reworking Tier-2 jobs (`workflows/job.ts`) beyond shared-helper extraction.
- Multi-channel changes beyond the Sendblue/iMessage path.

## Decisions

### D1. One long-lived workflow run per thread (not per turn)
A per-thread workflow run loops `while (true) { agent.stream(...); await hook }`, processing one turn at a time and suspending on a hook between turns. Rationale: this is WDK's documented multi-turn pattern and it folds three concerns into the runtime at once — per-thread serialization (one active run per thread), mid-turn steering (queue + `prepareStep`), and resumability. **Alternative considered — one run per turn:** simpler lifecycle, but loses cross-turn serialization (would need an external lock) and makes steering a cross-run concern. Rejected. **Alternative — thin per-turn shell** (run registered for the dashboard, tool loop stays in-process): cheapest and lowest-risk, gets observability only; explicitly *not* chosen as the primary path because it does not deliver mid-turn resumability — but documented as the fallback if per-step latency proves unacceptable.

### D2. Delivery as a durable step
`send_message`'s `execute` becomes a `'use step'` that REST-sends by threadId via `adapter.postMessage` — the same path proactive/Tier-2 sends already use. Rationale: no live `Thread` handle exists inside the workflow runtime, and delivery is already not socket-coupled. Marking it a step gives at-most-once-ish delivery via step memoization on replay (a replayed turn does not re-send). The delivery-recovery pass (D-MG8) and `stay_silent` are preserved as workflow-level logic operating on the same assembled message.

### D3. Steering via hook + non-blocking queue
The gateway routes a mid-run owner message by calling `resumeHook(runId, event)`. Inside the workflow, a non-blocking `hook.then(e => queue.push(e))` listener fills an in-memory array; the turn's `prepareStep` does `queue.splice(0)` and appends the messages (group sender-name prefixing preserved from `loop.ts:200-203`). Rationale: 1:1 port of today's drain semantics with the only change being the feed (hook resume vs. in-process push). The non-blocking listener resolves the "don't block the turn waiting for a steer that never comes" problem. **Alternative — blocking `await hook` between steps:** would stall every turn awaiting a maybe-never message. Rejected.

### D4. Typing stays gateway-side, fed by the run stream
The gateway (which still receives the webhook and holds the live handle) tails the run's output readable — the same `getWritable<UIMessageChunk>()` stream passed to `DurableAgent` for observability — and re-fires `startTyping` on each chunk, stopping when the stream closes. Rationale: the live `Thread` handle only exists in the gateway process; driving typing from inside the workflow would be a non-deterministic side effect with no handle anyway. This also upgrades today's single-shot typing to a refreshed indicator across long turns at no extra plumbing (reuses the observability stream). **Alternative — typing-by-number REST step inside the workflow:** possible (Sendblue has a typing endpoint) but pointless given the gateway already holds the native handle. Rejected.

### D5. Idempotency and restart recovery move to the runtime
Per-message dedup (today `store.appendInbound` + the dispatcher `seen` set) is kept at the gateway boundary for webhook-retry dedup, but the "re-run an un-answered message after restart" responsibility (D-DE1) is satisfied by the durable run resuming from its last step. Rationale: avoids double-driving recovery from two systems. The gateway still persists inbound-on-arrival (D-DE1 first half) and routes to the per-thread run, which either resumes (crash) or processes fresh.

### D6. Tool `execute`s wrapped as steps; shared with Tier 2
In-turn tools (`bash`, `file_read`, memory, schedule, credential, `send_message`) get `'use step'` `execute` seams, reusing the wrapping already built for `workflows/job.ts`. `stay_silent` and any tool that uses workflow primitives stay workflow-level (not steps). System-prompt building, delivery classification, and persistence stay workflow-level orchestration. Rationale: maximize reuse with the Tier-2 path; keep the byte-stable cached prefix and adaptive thinking by passing the same `instructions`/`providerOptions` already used in `loop.ts`.

## Risks / Trade-offs

- **Per-step durability overhead on the hot path** → Each in-turn tool call becomes a Postgres write + worker dispatch. Mitigation: against multi-second LLM calls the per-step cost is small for a single sporadic user; benchmark turn latency before/after; D1's thin-shell fallback is the escape hatch if unacceptable.
- **Delivery double-send on replay** → A turn that replays could re-emit a send. Mitigation: send is a memoized step (replay returns the cached result, no re-send); validate with an integration test that replays a turn and asserts a single outbound.
- **Steering races at step boundaries** → A message landing between `splice` and the next LLM call. Mitigation: mirror today's synchronous drain semantics; the queue is drained at every `prepareStep`, and any straggler is folded on the following step or starts the next turn (same guarantee as `dispatcher.ts:91-95`).
- **Typing stream coupling** → If the run stream stalls but the turn is alive, typing could lapse. Mitigation: acceptable (parity-plus with today's single fire); optionally floor with a periodic refresh while the run is non-terminal.
- **Hook/run lifecycle leaks** → Long-lived per-thread runs that never terminate. Mitigation: define an idle-timeout/`/done`-style suspension and a recovery path that restarts a thread's run on the next inbound if its run is gone.
- **Prompt-cache regression** → Moving prompt assembly into the workflow could perturb the cached prefix. Mitigation: build `instructions` identically (same `cacheControl` ephemeral breakpoint) and assert cache hits via `cachedIn`/`cacheWriteIn` in turn telemetry.

## Migration Plan

1. Extract shared turn logic (prompt build, tool wrapping, delivery classification/recovery, persistence) into helpers usable by both the in-process loop and a workflow.
2. Add the per-thread conversational workflow (`DurableAgent` + hook loop + `prepareStep` steering + delivery step) behind a config/env flag, with the existing in-process loop as default.
3. Wire the gateway to start/resume the per-thread run and to tail the run stream for typing; keep inbound persistence + webhook dedup.
4. Validate: integration tests for resume-after-crash (single outbound), steering fold, typing refresh, idempotent re-delivery; confirm Tier-1 runs in `workflow inspect`; confirm Langfuse session grouping + prompt-cache hits unchanged.
5. Flip the flag to durable Tier 1; retire the in-process `TurnDispatcher` serialization and the D-DE1 restart-recovery pass once the durable path is proven.
6. **Rollback**: flip the flag back to the in-process loop; both paths share the extracted helpers, so no data migration is required.

## Open Questions

- Per-thread run lifecycle: idle-timeout vs. keep-alive, and how the gateway rebinds to a thread whose run has terminated (restart the run on next inbound).
- Does `DurableAgent` `onStepFinish`/stream output give enough fidelity to reproduce the current per-step turn log (`loop.ts:209-225`) and the end-of-turn summary, or do we keep a parallel Langfuse export?
- Exact dedup boundary: keep the dispatcher `seen` set for in-session webhook-retry dedup, or rely solely on `store.appendInbound` + run idempotency.
- Whether to also migrate Tier-2 jobs onto the same extracted helpers now, or defer to a follow-up.
