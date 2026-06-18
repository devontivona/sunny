# Design — Subagents

> Carved out of the `bootstrap-sunny` change (originally Phase 7).

# Subagents

## Context (subagents)

Complex tasks generate noisy intermediate work — large tool outputs, exploratory reads, dead ends — that, if run in the main thread, bloat the parent's context and cost. Delegation lets Sunny run a subtask in an isolated child agent and bring back only the result. The primary motivation is **context/token preservation**; bounded delegation and least-privilege are what make it safe.

## Goals / Non-Goals (subagents)

**Goals:**
- Keep the parent context lean by isolating a subtask's intermediate work.
- Bound delegation so it can't fan out or recurse uncontrollably.
- Run subagents at least-privilege (never broader than the parent).
- Compose with durability and with injection containment.

**Non-Goals:**
- Unbounded multi-level agent hierarchies.
- Subagents with broader permissions/credentials than their parent.

## Decisions (subagents)

### D-SUB1 — `delegate_task`: isolated context, result-only return

Sunny delegates a subtask to a child agent with its own isolated context and a restricted toolset. Only the child's **final result/summary** returns to the parent — the child's intermediate tool calls and large outputs never enter the parent's context. This is the context-preservation win.

### D-SUB2 — Bounded fan-out and depth

Concurrency is capped (default ~3 concurrent children) and spawn depth is capped (default 2). Children cannot delegate further unless explicitly designated orchestrators. This prevents runaway self-fan-out (mirrors the anti-recursion spirit of `scheduling` D-SC4).

### D-SUB3 — Least-privilege subagents

A subagent's tools and credential references are a **subset** of the parent's, never broader. All subagent actions pass through the same tool-access gating, approval tiers, and blocklist (`security-permissions`, `tool-access`). A subagent cannot resolve a credential reference its parent couldn't.

### D-SUB4 — Durable delegation

A delegated task MAY run as a Tier-2 durable job (`durable-execution`), so a long subtask survives restarts and reports back on completion via the gateway.

### D-SUB5 — Injection-containment synergy

Processing untrusted content (a sketchy web page, an email body) can be delegated to a subagent granted **no credentials and no high-consequence tools**, so a prompt injection in that content is contained to a powerless child (reinforces security D-SEC6).

### D-SUB6 — Observed

Subagent runs appear as child spans/trajectories in `observability`, so delegated work is as inspectable as the parent's.

### Rejected alternatives (subagents)

- **Unbounded recursive delegation:** runaway cost/fan-out; rejected via depth/concurrency caps (D-SUB2).
- **Subagents inheriting full or broader permissions:** rejected for least-privilege (D-SUB3) — delegation should narrow, not widen, blast radius.
- **Deferring subagents entirely:** rejected; kept in v1 because context/token preservation is load-bearing for complex tasks.

## Risks / Trade-offs (subagents)

- **Coordination overhead:** delegation adds latency and prompt overhead; worth it only when the subtask's intermediate work is genuinely large. Guidance lives in the agent's instructions/skills.
- **Result-only return can lose context:** the parent sees a summary, not the full work; mitigated by trajectories (D-SUB6) for when detail is needed.
- **Caps may be too tight/loose:** defaults (3 concurrent, depth 2) need tuning against real workloads.

---

