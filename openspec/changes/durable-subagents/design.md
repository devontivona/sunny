# Design — Durable Subagents

> Supersedes the carved-out `subagents` change. Reframed: subagents are not a new capability but a generalization of `durable-execution`. Depends on `durable-main-loop`.

> **⚠️ NEEDS RECONCILIATION before implementation (added 2026-06-28, post v6→v7 migration + post `durable-main-loop` landing):**
> 1. **Primitive renamed (v7):** the durable agent is now `@ai-sdk/workflow`'s **`WorkflowAgent`**, not `@workflow/ai`'s `DurableAgent` (which v7 replaced). Read `DurableAgent` below as `WorkflowAgent`.
> 2. **Telemetry (v7):** durable runs currently emit **no external trajectory telemetry** (OTel/Langfuse) — a known AI SDK v7 + Workflow DevKit limitation (durable agent telemetry dispatches inside an isolated `node:vm` realm `registerTelemetry` can't reach; explicitly disabled, see the `migrate-ai-sdk-v7-workflow-agent` change). So D-DS10 / "Child runs are observable" are amended: child runs are inspectable via the **WDK runs inspector**, but external trajectory telemetry is off until upstream (vercel/ai#12164) or the shelved bridge restores it.
> 3. **Steering model (pre-v7, from `durable-main-loop`):** this design's `resumeHook(runId, event)` + "suspends on a hook" + `prepareStep` drain premise describes the **keep-alive** model that `durable-main-loop` ultimately **abandoned** (it caused a turns-2+ hook FIFO **parking bug**). The shipped model is **one durable run per turn**, gateway-serialized, steered by **`loadSteers`** (a store read inside `prepareStep`), NOT `resumeHook`. The child↔parent channel here (child `send_message`→`resumeHook(parentRun)`, `message_subagent`→`resumeHook(childRun)`) must be re-grounded on that shipped model — likely a durable store the recipient's next turn-run drains via `loadSteers`, plus the gateway/router starting the next run — rather than a cross-turn hook listener (which parks). This is a substantive design change, NOT a mechanical rename, and is out of scope for the v7 PR.

## Context

Complex tasks generate noisy intermediate work — large tool outputs, exploratory reads, dead ends — that, if run on the main thread, bloat Sunny's context and cost. Delegation runs a subtask in an isolated child and brings back only the result. The primary motivation is **context/token preservation**; least-privilege and bounded fan-out are what make it safe; durability and async messaging are what make it *usable without polling*.

The load-bearing realization (reached across the exploration that produced this change): once `durable-main-loop` makes the main thread a long-lived `DurableAgent` run that suspends on a hook and is steered via `resumeHook(runId, event)` → `prepareStep` drain, **a subagent is the same workflow shell as the main thread**, differing only in (a) its counterparty, (b) its toolset, (c) its model. The owner↔Sunny relationship and the Sunny↔child relationship are structurally identical, one level apart:

```
   Owner (human)
     │ iMessage (gateway)        ▲ send_message → gateway → user
     ▼ resumeHook(sunnyRun)      │
   ┌────────────────────────────────────────┐
   │  SUNNY  — durable run                   │ suspends on hook between turns
   │  counterparty = owner                   │ steered via resumeHook + prepareStep
   └────────────────────────────────────────┘
     │ message_subagent          ▲ send_message  (output_target = "parent")
     ▼ resumeHook(childRun)      │  → resumeHook(parentRun)
   ┌────────────────────────────────────────┐
   │  SUBAGENT — durable run                 │ SAME shell, restricted tools, maybe sonnet
   │  counterparty = Sunny                   │ steered via resumeHook + prepareStep
   └────────────────────────────────────────┘
```

**Sunny is to its children what the owner is to Sunny.** The child doesn't know its "user" is an agent; it just calls `send_message`, and routing (driven by `output_target`) delivers to the parent's hook instead of the gateway.

## Goals / Non-Goals

**Goals:**
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

### D-DS1 — Output target is the unifying routing knob
Every durable run has `output_target ∈ {user, parent, silent}`. This subsumes the two booleans originally proposed ("has send_message?" / "talks to user?") — the meaningless 4th combination disappears. `user` routes `send_message` to the gateway (today's default for scheduled/promoted jobs). `parent` routes a run's messages to its spawning run's hook (delegate-and-await). `silent` suppresses all proactive output; the run completes and its result is logged only (this is the fix for the unwanted 2am memory-consolidation text). The `parent` value *is* the child→Sunny channel that the async-messaging design needs — #1 and #2 share one primitive.

### D-DS2 — Non-blocking delegation with a durable handle
`delegate_task(brief, {tools, model, output_target: "parent", ...})` starts an isolated-context child durable run, writes a durable parent↔child link, and returns a handle (`childId`) **immediately** — not the result. The parent's turn continues or ends and suspends. The child runs in its own context; its intermediate tool calls never enter the parent. Only messages the child deliberately sends (summaries) reach the parent — preserving the context win.

### D-DS3 — Await and async are the same mechanism
There is no separate blocking primitive. "Await" = the parent delegates, has nothing else to say, ends the turn, and suspends; the child's report wakes it (looks like blocking, costs nothing). "Async" = the parent keeps working and the child's report interleaves later as an event. Both are: delegate (non-blocking) → child reports via `resumeHook(parentRun)` → parent folds it at the next step boundary or wakes from idle — *exactly* like the owner double-texting Sunny.

### D-DS4 — Bidirectional messaging reuses the steering seam
Child→parent: the child's `send_message` (with `output_target="parent"`) becomes `resumeHook(parentRun, {from: childId, text, final?})`. Parent→child: a thin `message_subagent(childId, text)` tool calls `resumeHook(childRun, {from: "parent", text})`. Both are folded by the recipient's `prepareStep` with a sender-name prefix — the group-sender-prefix logic from the conversational turn already does almost exactly this; a child is just another named sender. No new transport, no polling.

### D-DS5 — Least-privilege children
A child's tools and credential references are a **subset** of the parent's, never broader. All child actions pass the same tool-access gating, approval tiers, and blocklist (`security-permissions`, `tool-access`). A child cannot resolve a credential reference its parent couldn't. An untrusted-content child can be granted **no credentials and no high-consequence tools**, containing a prompt injection to a powerless child (reinforces security D-SEC6).

### D-DS6 — Terminal failure / timeout is reported by a runtime watchdog
A dead or timed-out child cannot call `resumeHook` to report its own failure. So the orchestration runtime watches child runs and emits a `child_failed` / `child_timeout` event to the parent on terminal failure or budget exhaustion. This is the one piece that is *not* just the steering mechanism. It pairs with per-child token/time budgets (D-DS8).

### D-DS7 — Run-to-completion lifecycle in v1
A child runs to completion, emits a `final` report, then terminates and its link is cleaned up. The bidirectional-steering window is "while it is still working." Standing, long-lived collaborator children (the "idle child" problem, mirrored in `durable-main-loop`'s open question for the main thread) are out of scope for v1.

### D-DS8 — Bounded fan-out, depth, and budget
Concurrency is capped (default ~3 concurrent children), spawn depth is capped (default ~2), and a child cannot delegate further unless explicitly designated an orchestrator. Per-child token/time budgets bound runaway cost; on exhaustion the watchdog (D-DS6) reports to the parent. Rationale: prevent self-fan-out (mirrors `scheduling` D-SC4 anti-recursion) and the "depth 5 × branching 3 = 243 agents" blowup.

### D-DS9 — Configurable model per run
A delegated/background run MAY specify its model. Cheap/bounded children run on a smaller model; Sunny reserves the stronger model for orchestration/synthesis/high-stakes review. Selection guidance lives in the skill.

### D-DS10 — Observed
Child runs appear as nested runs/steps in the **WDK workflow runs inspector**, so delegated work is as inspectable as the parent's (rides `durable-main-loop`'s runtime-observability work). **NOTE (v7):** external trajectory telemetry (OTel → Langfuse) is currently NOT emitted for durable runs — a known AI SDK v7 limitation (see the reconciliation note at the top + the `migrate-ai-sdk-v7-workflow-agent` change). Child runs inherit the parent's telemetry posture: when durable trajectory telemetry is re-enabled (upstream fix or the shelved event-forwarding bridge), child spans associate with the parent run; until then, the runs inspector is the observability surface.

### Rejected alternatives
- **A separate `subagents` capability** — rejected; it would re-list inherited durable-execution substrate (isolation, durability, observability) as if novel. The only genuinely new mechanics are output-target routing, least-privilege subset, and the watchdog.
- **Handoff / transfer-of-control** (OpenAI-SDK style) — rejected; Sunny is a single-owner thread with no triage topology. Delegation-and-return is the right verb; control should stay with the orchestrator.
- **Building #2 on the in-process dispatcher before `durable-main-loop`** — rejected as throwaway work against machinery being retired, with a non-durable parent.
- **A blocking-await primitive** — rejected; redundant given D-DS3.
- **Parallel-mutation orchestration** — rejected for v1; the interdependence principle says isolation fails for coupled work (Skill §1).

## Risks / Trade-offs

- **Token cost:** multi-agent uses ~15× chat tokens (~4× for single-agent); token volume alone explained ~80% of performance variance in Anthropic's research eval. Delegation must be value-gated — the skill encodes when it's worth it.
- **Result-only return loses context:** the parent sees a summary, not the work; mitigated by observability (D-DS10) and by the option to fork-with-context for dependent work.
- **Coordination overhead & latency:** worth it only when intermediate work is genuinely large or genuinely parallel.
- **Ping-pong loops:** parent↔child both steerable could chatter; mitigated by depth/breadth caps (D-DS8), no-spawn-unless-orchestrator, and (if needed) a per-child message-rate ceiling.
- **Caps need tuning:** defaults (3 concurrent, depth 2) are guesses against real workloads.
- **Interdependence failure mode:** isolated children silently make conflicting assumptions on coupled tasks (the "Flappy Bird mismatched art" failure); mitigated by the skill steering delegation toward read/explore/contain and away from coupled mutation.

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
