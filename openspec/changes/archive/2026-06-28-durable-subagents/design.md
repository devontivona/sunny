# Design — Durable Subagents

> Supersedes the carved-out `subagents` change. Reframed: subagents are not a new capability but a generalization of `durable-execution` into **one durable-run shell** on which delegation, background jobs, and scheduled jobs are profiles. Builds on `durable-main-loop` (shipped).

> **Re-grounded on the shipped runtime (2026-06-28, post v6→v7 migration + post `durable-main-loop`).** Three corrections from the draft this design started as:
> 1. **Primitive (v7):** the durable agent is `@ai-sdk/workflow`'s **`WorkflowAgent`**, not `@workflow/ai`'s `DurableAgent`. All references below are `WorkflowAgent`.
> 2. **Telemetry (v7):** durable runs emit **no external trajectory telemetry** (OTel/Langfuse) — a known AI SDK v7 + WDK limitation (the agent loop runs in an isolated `node:vm` realm `registerTelemetry` can't reach; explicitly disabled, see the `migrate-ai-sdk-v7-workflow-agent` change). Child runs are inspectable via the **WDK runs inspector**; external trajectory telemetry stays off until upstream (vercel/ai#12164) or the shelved bridge restores it. Folded into D-DS10.
> 3. **Steering model:** the draft's `resumeHook(runId, event)` + "suspends on a hook" + `prepareStep` drain described the **keep-alive** model `durable-main-loop` **abandoned** (it caused a turns-2+ hook FIFO **parking bug**). Shipped model: **one durable run per turn**, the in-process `DurableTurnRouter` starts the next run when the store shows unanswered inbound, and steering is **`loadSteers`** (a store read inside `prepareStep`). The parent↔child channel below is re-grounded on that: child→parent and parent→child are **store writes** drained by the recipient's run via `loadSteers` (and a fresh run started by the supervisor when the recipient is idle), NOT `resumeHook`. See D-DS2/3/4/6 and D-DS11–14.

## Context

Complex tasks generate noisy intermediate work — large tool outputs, exploratory reads, dead ends — that, if run on the main thread, bloat Sunny's context and cost. Delegation runs a subtask in an isolated child and brings back only the result. The primary motivation is **context/token preservation**; least-privilege and bounded fan-out are what make it safe; durability and async messaging are what make it *usable without polling*.

The load-bearing realization (reached across the exploration that produced this change): `durable-main-loop` makes the main thread a durable `WorkflowAgent` run whose inbox is a thread in the store, whose runs are *supplied* by the `DurableTurnRouter` (a fresh run per turn while unanswered inbound exists), and which is steered via `loadSteers` (a store read folded in `prepareStep`). Given that, **a subagent — and a background job, and a scheduled job — is the same shell as the main thread**, differing only in (a) its counterparty (`output_target`), (b) its toolset, (c) its model, and (d) its run-supply policy (the owner conversation gets perpetual runs; jobs/children run once). The owner↔Sunny relationship and the Sunny↔child relationship are structurally identical, one level apart — and crucially, *a child is just another thread in the same store*:

```
   Owner (human)
     │ iMessage → gateway.appendInbound(ownerThread)   ▲ send_message → emit → gateway → owner
     ▼ DurableTurnRouter.route → start(turn-run)        │
   ┌────────────────────────────────────────────────────┐
   │  SUNNY  — durable run, one per turn                 │ inbox = owner thread (in store)
   │  output_target = user                               │ steered via loadSteers in prepareStep
   └────────────────────────────────────────────────────┘
     │ message_subagent(child)                ▲ send_message  (output_target = "parent")
     ▼ appendInbound(childInbox) + supervisor │  → emit → appendInbound(parentInbox) + supervisor
   ┌────────────────────────────────────────────────────┐
   │  SUBAGENT — durable run (runs once)                 │ inbox = its OWN child thread (in store)
   │  output_target = parent, restricted tools, maybe    │ steered via loadSteers in prepareStep
   │  a smaller model                                    │ supervisor awaits returnValue (watchdog)
   └────────────────────────────────────────────────────┘
```

**Sunny is to its children what the owner is to Sunny.** The child doesn't know its "user" is an agent; it just calls `send_message`, and routing (driven by `output_target`, invisible at the tool surface) writes to the parent's inbox instead of the gateway. There is no hook anywhere: every recipient drains its own inbox via `loadSteers`, and the supervisor (the generalized router) starts a fresh recipient run when one is idle.

## Goals / Non-Goals

**Goals:**
- Unify the conversational turn, background job, scheduled job, and child agent onto **one durable-run shell** (`runAgent(profile)`) + one run-supply engine, so they differ only in config — removing the three divergent workflow implementations (D-DS11/13).
- Keep the parent context lean by isolating a subtask's intermediate work; return only what the child reports.
- Async, non-blocking delegation: the parent never blocks on a child.
- Proactive, poll-free child→parent reporting and parent→child steering.
- Run children at least-privilege (never broader than the parent) and on a configurable model.
- Let any durable run choose its output target (user / parent / silent).
- Bound delegation so it can't fan out or recurse uncontrollably.
- Teach Sunny, via a skill, *when* and *how* to delegate — and when not to.

**Non-Goals:**
- Unbounded multi-level agent hierarchies.
- Children with broader permissions/credentials than their parent.
- A separate blocking-await primitive (await and async are the same mechanism — see D-DS3).
- Standing, long-lived collaborator children in v1 (run-to-completion-then-terminate — D-DS7).
- Parallel-mutation orchestration (delegation is optimized for isolated read/explore/contain, per the interdependence principle — see Skill §1).

## Decisions

### D-DS1 — Output target is the unifying routing knob, invisible at the tool surface
Every durable run has `output_target ∈ {user, parent, silent}`. This subsumes the two booleans originally proposed ("has send_message?" / "talks to user?") — the meaningless 4th combination disappears. The target resolves to a `{transport, destThreadId}`: `user` → `(gateway, ownerThread)` (today's default for scheduled/promoted jobs); `parent` → `(appendInbound + supervisor, parentInbox)` (delegate-and-await); `silent` → none (no proactive output; see D-DS14 for how the result is still recorded). **It is invisible at the tool surface** — `send_message(text)` carries no `target` argument and the model never branches on destination. The agent's awareness of its counterparty comes from its profile *instructions* and the tool's *description* string (a child's `send_message` is described "report to your orchestrator"), not from the mechanism. The `parent` value *is* the child→Sunny channel the async-messaging design needs — output routing and the bidirectional channel share one primitive.

### D-DS2 — Non-blocking delegation with a durable handle
`delegate_task(brief, {tools, model, output_target: "parent", ...})` starts an isolated-context child run (via the shared shell, D-DS11), writes a durable parent↔child link, and returns a handle (`childId`) **immediately** — not the result. The parent's turn then simply **ends** (it does not "suspend" — there is no keep-alive run to park; D-DS3). The child runs in its own context with its own inbox thread; its intermediate tool calls never enter the parent. Only messages the child deliberately sends (summaries) reach the parent — preserving the context win.

### D-DS3 — Await and async are the same mechanism (restart, not wake)
There is no separate blocking primitive, and nothing suspends on a hook. "Await" = the parent delegates, has nothing else to say, and **ends its turn**; when the child reports, the report lands as unanswered inbound on the parent's thread and the **supervisor starts a fresh parent turn-run** to handle it (looks like blocking, costs nothing — exactly like the owner texting Sunny back later). "Async" = the parent keeps working in the same turn; if it is still in-flight when the child reports, its own `loadSteers` folds the report at the next step boundary. Both are one path: child writes to the parent's inbox → (parent in-flight → `loadSteers` folds it) **or** (parent idle → supervisor starts the next parent run). Identical to owner double-texting Sunny, because the parent *is* a normal thread.

### D-DS4 — Bidirectional messaging reuses the store + `loadSteers` seam (no `resumeHook`)
Child→parent: the child's `send_message` (with `output_target="parent"`) emits to the parent's inbox — `appendInbound(parentInbox, {from: childId, text, final?})` (a `'use step'`) followed by nudging the supervisor for that thread. Parent→child: a thin `message_subagent(childId, text)` tool does `appendInbound(childInbox, {from: "parent", text})` + nudge. In both directions the recipient's running turn folds the message via `loadSteers` in `prepareStep` with a sender-name prefix — the group-sender-prefix logic (`steerMessageText`) from the conversational turn already does exactly this; a child is just another named sender. If the recipient is idle (its run already ended), the supervisor starts a fresh run that drains the inbox. No hook, no polling, no new transport — the same machinery `durable-main-loop` shipped, generalized to a second thread.

### D-DS5 — Least-privilege children
A child's tools and credential references are a **subset** of the parent's, never broader. All child actions pass the same tool-access gating, approval tiers, and blocklist (`security-permissions`, `tool-access`). A child cannot resolve a credential reference its parent couldn't. An untrusted-content child can be granted **no credentials and no high-consequence tools**, containing a prompt injection to a powerless child (reinforces security D-SEC6).

### D-DS6 — Terminal failure / timeout is the supervisor's `await`
A dead or timed-out child cannot report its own failure. The **delegation supervisor** (the run-supply engine, D-DS13) is the run that `start`s the child and `await`s its `returnValue` — exactly as `DurableTurnRouter.runTurn` awaits a turn-run today. Its catch/timeout branch writes a `child_failed` / `child_timeout` event to the parent's inbox (then nudges the supervisor, like any child report). So the watchdog is *not* a separate poller — it is the supervisor's `await`, the one place that already observes terminal failure. It pairs with per-child token/time budgets (D-DS8).

### D-DS7 — Run-to-completion lifecycle in v1
A child runs to completion, emits a `final` report, then terminates and its link is cleaned up. The bidirectional-steering window is "while it is still working." Standing, long-lived collaborator children (the "idle child" problem, mirrored in `durable-main-loop`'s open question for the main thread) are out of scope for v1.

### D-DS8 — Bounded fan-out, depth, and budget
Concurrency is capped (default ~3 concurrent children), spawn depth is capped (default ~2), and a child cannot delegate further unless explicitly designated an orchestrator. Per-child token/time budgets bound runaway cost; on exhaustion the watchdog (D-DS6) reports to the parent. Rationale: prevent self-fan-out (mirrors `scheduling` D-SC4 anti-recursion) and the "depth 5 × branching 3 = 243 agents" blowup.

### D-DS9 — Configurable model per run
A delegated/background run MAY specify its model. Cheap/bounded children run on a smaller model; Sunny reserves the stronger model for orchestration/synthesis/high-stakes review. Selection guidance lives in the skill.

### D-DS10 — Observed (runs inspector; external telemetry off under v7)
Child runs appear as runs/steps in the **WDK workflow runs inspector**, so delegated work is as inspectable as the parent's (rides `durable-main-loop`'s runtime-observability work). External trajectory telemetry (OTel → Langfuse) is **NOT** emitted for durable runs under AI SDK v7 — the agent loop runs in an isolated `node:vm` realm the global `registerTelemetry` can't reach, so it is explicitly disabled (see the re-grounding note at top + the `migrate-ai-sdk-v7-workflow-agent` change). Child runs inherit the parent's posture: when durable trajectory telemetry is re-enabled (upstream fix vercel/ai#12164 or the shelved event-forwarding bridge), child spans associate with the parent run; until then the runs inspector is the observability surface.

### D-DS11 — One durable-run shell; profiles, not separate workflows
The conversational turn, background job, and scheduled job each re-implement the same `WorkflowAgent` shell (build instructions → `agent.stream` with `loadSteers` in `prepareStep` → finalize/deliver). Extract that into a single parameterized run, `runAgent(profile)`, where `profile = {threadId (inbox), instructionsBuilder, tools, model, providerOptions, output_target, finalize}`. The three existing workflows become profiles and `delegate_task` adds a fourth; they differ *only* in config and run-supply policy (D-DS13), not in mechanism. **The conversation's rich finalize is preserved, not forced on jobs:** finalize is one parameterized strategy (D-DS14), so the conversation keeps delivery-classification + the recovery backstop + turn-record persistence while a job gets a simple emit. This is the substrate the whole change rests on — "a subagent is the same shell as the main thread" generalized to *every* durable run.

### D-DS12 — Inbox thread ⟂ output_target
Every run has two thread-ish things the owner conversation happens to collapse into one: its **inbox thread** (where *its* steers arrive — its own steering surface) and its **report-to** (where its sends go, resolved by `output_target`). They coincide only for the owner conversation (inbox = owner thread, `output_target=user` → that same thread via the gateway). A background job has its **own** inbox thread but reports to the owner; a child has its own inbox thread but reports to its parent's inbox. Keeping them distinct is load-bearing: if a background job's inbox were the owner thread, an owner double-text would bleed into both Sunny's turn and the job. A consequence: because every run now has its own inbox, **every run is steerable** — not just children. Wiring *who* may steer a background/scheduled job (its spawner? the owner via Sunny?) is a latent affordance, not in v1 scope; the structural capability comes free.

### D-DS13 — Run-supply policy generalizes the router into the supervisor
`DurableTurnRouter` today hardcodes `start(runConversation)` and supplies a *perpetual* stream of turn-runs for the owner thread (a new run while unanswered inbound exists). Generalize it into the **delegation supervisor**: a registry of `thread → {profile, run-supply policy}`. The owner/group threads keep the **perpetual** policy; jobs and children get a **single-run** policy (start once, run to completion — D-DS7 — with in-flight `loadSteers` steering). Each trigger is just a registration that asks the supervisor to supply run(s): gateway inbound → register owner thread (perpetual); `cron tick` → register a scheduled-job thread (single); `start_job` → register a background-job thread (single); `delegate_task` → register a child thread (single, + link + caps + the D-DS6 watchdog `await`). One engine; the conversation is *N runs over one inbox*, a job/child is *1 run over one inbox*.

### D-DS14 — `send_message` is the single outward primitive; "deliver" is its backstop branch
There is one outward path — `emit(text) → route(output_target)` — reached two ways: the agent calling `send_message` (intentional, mid-run, possibly N times) **or** the finalize backstop emitting the run's final text when the agent produced text but never sent (terminal). A background job's old `deliver()` *was* the second case all along — identical to the conversation's recovery backstop — so it is **deleted** as a separate concept and folded into the shared finalize. The only per-profile knob is how a no-send miss recovers: `recoverOnMiss: 'model'` (conversation — rewrite private scratch into a clean iMessage), `'rawtext'` (job — the final assistant text *is* the deliverable, emit as-is, no extra model call), or `'none'` (silent). Two orthogonal axes, mirroring D-DS12 on the output side: **record-always** (every run persists its turn record to its own thread, for history/inspection, regardless of `output_target`) ⟂ **emit-by-target** (`send_message`/backstop pushes outward only when not silent). `silent` profiles therefore omit the `send_message` tool entirely — the agent cannot speak into a void, yet its result is still recorded (satisfying the "silent maintenance job records its result" requirement). A silent job's failures are surfaced by the supervisor (D-DS6), not by the agent.

### Rejected alternatives
- **A separate `subagents` capability** — rejected; it would re-list inherited durable-execution substrate (isolation, durability, observability) as if novel. The genuinely new mechanics are the unified shell + run-supply policy, output-target routing, least-privilege subset, and the supervisor watchdog.
- **`resumeHook`/keep-alive parent** — rejected; it is the model `durable-main-loop` abandoned over the turns-2+ FIFO parking bug. The store + `loadSteers` + supervisor-restart path replaces it (D-DS3/4).
- **Per-profile workflow forks** (keep `conversation.ts` / `job.ts` / `scheduledJob.ts` separate) — rejected; they are the same shell with different config, and the divergence already cost a duplicated `loadSteers`/telemetry/stream-bridge implementation in each. One `runAgent(profile)` with a parameterized finalize (D-DS11/14) removes the duplication without regressing the conversation's backstop.
- **Keeping `deliver()` distinct from `send_message`** — rejected; they are one act at two intentionality levels (D-DS14). Two names for one emit is the kind of accidental split this change exists to remove.
- **Handoff / transfer-of-control** (OpenAI-SDK style) — rejected; Sunny is a single-owner thread with no triage topology. Delegation-and-return is the right verb; control should stay with the orchestrator.
- **A blocking-await primitive** — rejected; redundant given D-DS3.
- **Parallel-mutation orchestration** — rejected for v1; the interdependence principle says isolation fails for coupled work (Skill §1).

## Risks / Trade-offs

- **Token cost:** multi-agent uses ~15× chat tokens (~4× for single-agent); token volume alone explained ~80% of performance variance in Anthropic's research eval. Delegation must be value-gated — the skill encodes when it's worth it.
- **Result-only return loses context:** the parent sees a summary, not the work; mitigated by observability (D-DS10) and by the option to fork-with-context for dependent work.
- **Coordination overhead & latency:** worth it only when intermediate work is genuinely large or genuinely parallel.
- **Ping-pong loops:** parent↔child both steerable could chatter; mitigated by depth/breadth caps (D-DS8), no-spawn-unless-orchestrator, and (if needed) a per-child message-rate ceiling.
- **Caps need tuning:** defaults (3 concurrent, depth 2) are guesses against real workloads.
- **Interdependence failure mode:** isolated children silently make conflicting assumptions on coupled tasks (the "Flappy Bird mismatched art" failure); mitigated by the skill steering delegation toward read/explore/contain and away from coupled mutation.
- **Refactoring shipped run workflows:** folding `conversation.ts` / `job.ts` / `scheduledJob.ts` onto the shared shell (D-DS11) touches working, shipped code — scheduled jobs and background jobs deliver correctly today. Mitigated by keeping behavior identical per profile (the conversation's `recoverOnMiss: 'model'` finalize and turn-record persistence are unchanged) and re-testing each profile's delivery path; the refactor is mechanism-only, not a behavior change.

---

## Delegation Skill — authoring spec

> This section preserves the research behind the skill so it is not lost. The skill **file** is authored at implementation time (tasks.md §7); its content is specified here. Sources: Anthropic "Building Effective Agents" and "How we built our multi-agent research system"; Claude Code / Claude Agent SDK subagent docs; Cognition "Don't Build Multi-Agents"; the MAST multi-agent-failure taxonomy; Mastra / Vercel AI SDK / OpenAI Agents SDK / LangGraph composition models; the "code mode" / CodeAct line of work.

### §1 — When to delegate (and when NOT to) — the interdependence principle
The single variable that decides whether delegation helps: **do the children take interdependent actions or need each other's intermediate state?**
- **Isolation WINS** for bounded, read-only, parallelizable work where children don't need each other's state: research, search, multi-source digest, summarizing a long thread, untrusted-content triage. *Delegate freely.*
- **Isolation FAILS** for coupled work where one child's choices constrain another's (most code edits, builds): dispersed decisions produce silently conflicting assumptions. *Keep it on one thread.*
- **Value-gate:** delegation costs ~15× chat tokens; reserve it for breadth-first, context-exceeding, parallelizable tasks. A single agent at equal token budget often matches a multi-agent setup — don't delegate the trivial.

### §2 — How to write a task brief (the four-part contract)
A child sees **none** of the parent's context — the brief is the only channel. Every delegation states: **(1) objective, (2) output format, (3) tool/source guidance, (4) clear boundaries.** Vague briefs ("research the semiconductor shortage") cause duplicated work, gaps, and overlap. For dependent work, pass the relevant *trace/decisions*, not just a one-line message.

### §3 — Output target selection
- `parent` — delegated subtasks whose result Sunny will use to reason or to talk to the owner (the default for `delegate_task`).
- `silent` — maintenance with no news value: nightly memory consolidation/tidy, index rebuilds. (Stops the 2am text.)
- `user` — scheduled work the owner explicitly wants delivered: a morning digest, a reminder, a finished long-running job.

### §4 — Model selection
- Smaller model (sonnet/haiku) for bounded, well-specified, high-volume children: reads, extraction, classification, single-purpose research legs.
- Stronger model for orchestration, synthesis, and high-stakes verification/review.
- Tier deliberately: a strong lead orchestrating cheap workers is the canonical cost-effective shape.

### §5 — Patterns
- **Delegate-and-await** — one child does bounded work, returns a compact summary; Sunny composes the user-facing reply. The child never messages the owner.
- **Parallel fan-out → synthesize** — split an independent task into N children (scaling rule: ~1 child / 3–10 tool calls for simple; 2–4 for moderate; 5+ for broad), gather results as they report, then Sunny synthesizes. A dedicated synthesis/attribution pass (cf. Anthropic's CitationAgent) keeps aggregation clean.
- **Verifier / critic (adversarial)** — after producing a finding, spawn one or more skeptics *prompted to refute it*; kill the finding if a majority refute. Use perspective-diverse verifiers (correctness / security / does-it-reproduce) rather than identical ones. MAST attributes ~21% of multi-agent failures to missing verification — always assign a referee for high-stakes output. (Judges drift and are gameable: low temperature, average multiple votes.)
- **Research** — lead plans → workers explore different facets in parallel (each with its own context as an "intelligent filter") → lead synthesizes → optional citation pass. Start broad, then narrow.
- **Untrusted-content containment** — process a hostile web page / sketchy email in a child with **no credentials and no high-consequence tools**; it returns a sanitized summary. A prompt injection is contained to a powerless child.
- **Evaluator-optimizer** — generate → critique against explicit criteria → refine; loop with a bounded iteration cap. Use when criteria are clear and iteration measurably helps.
- **Routing** — classify the request, then dispatch to a specialized child/model (cheap model for easy, strong for hard).

### §6 — Structured returns
Ask children to return **compact, structured** summaries, not raw tool dumps ("under N words; do NOT include raw tool output"). Treat each child→parent boundary as a typed contract so errors don't propagate silently; on a malformed return, re-brief and retry.

### §7 — Bounds & safety (operating rules)
- Respect depth/breadth caps; don't fan out past the configured concurrency.
- A non-orchestrator child must not delegate further.
- Set a per-child budget; expect a `child_failed`/`child_timeout` event if a child dies or overruns, and handle it (retry / drop-and-continue / tell the owner).
- Abort and restart a child only when new information invalidates its task; otherwise steer it via `message_subagent`.

### §8 — Bidirectional comms usage
- Nudge a still-working child with `message_subagent(childId, ...)` when you learn something it should know; it folds the nudge at its next step.
- Children should report **progress** proactively for long tasks, and a **final** result when done — Sunny need not poll.
- For fan-out, track outstanding `childId`s and synthesize once the set you need has reported; you may act on partial results when sufficient.

### §9 — Anti-patterns
- Delegating coupled/shared-context work (see §1).
- Delegating trivial work whose coordination overhead exceeds its benefit.
- Vague briefs (see §2).
- Fanning out without a synthesis/verification step (orphaned findings).
- Children messaging the owner directly when they should report to the parent (wrong `output_target`).
