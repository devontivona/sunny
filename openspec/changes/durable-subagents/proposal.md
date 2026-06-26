## Why

Some tasks are big enough to blow out Sunny's context window, parallelizable enough to be worth fanning out, or risky enough that they should run with fewer privileges than the main agent. Today the only way to run work off the main thread is a Tier-2 durable job that always notifies the *user* on completion — which (a) can't return a result *to Sunny* for further reasoning, (b) can't run silently for maintenance (the nightly memory-consolidation job texts the owner at 2am for no reason), and (c) can't be constrained below full privilege.

This change generalizes durable execution into a delegation substrate. It is **not** a new "subagents" capability — once the main loop is a durable, hook-driven run (`durable-main-loop`), a subagent is just *another durable run whose counterparty is Sunny instead of the owner*. Sunny becomes, in effect, the gateway for its own children. The parent↔child channel reuses the exact `resumeHook` + `prepareStep` steering mechanism that `durable-main-loop` builds for owner↔Sunny steering, so async bidirectional communication falls out almost for free.

## What Changes

- **Configurable output target** for any durable run: `user` (report to the owner via the gateway — today's behavior), `parent` (report to the spawning run — delegate-and-await), or `silent` (no proactive message — fixes the unwanted 2am memory-tidy text).
- **Configurable model** per run, so cheap/bounded children can run on a smaller model (e.g. sonnet/haiku) while Sunny orchestrates.
- **Non-blocking delegation**: `delegate_task` starts an isolated-context child durable run, records a durable parent↔child link, and returns a handle *immediately* — the parent never blocks. Only what the child chooses to report enters the parent's context (context-preservation win).
- **Least-privilege children**: a child's toolset and credential references are a subset of the parent's; an untrusted-content child can be granted none.
- **Bidirectional async messaging**: the parent may steer a still-working child, and a child may proactively report progress/results to its parent — both via the same hook-resume/fold-at-next-step mechanism as owner↔Sunny steering. No sleep-and-poll.
- **Terminal-failure watchdog**: a dead or timed-out child can't report for itself, so the runtime emits a failure/timeout event to the parent.
- **Bounds**: concurrency cap, depth cap, and no sub-delegation unless a child is designated an orchestrator.
- **A delegation skill** teaching Sunny *when and how* to delegate (patterns: fan-out→synthesize, verifier/critic, research, untrusted-content containment, evaluator-optimizer, routing), drawn from the research captured in `design.md`.

## Capabilities

### Modified Capabilities
- **durable-execution** — gains configurable output target + model, non-blocking child delegation with isolated context and result-only return, least-privilege children, bidirectional async parent↔child messaging, a terminal-failure watchdog, fan-out/depth bounds, and child-run observability.

### New Artifacts (non-capability)
- **Delegation skill** — authored guidance on delegation patterns and when *not* to delegate (contents specified in `design.md`).

## Dependencies

**Hard dependency on `durable-main-loop` — it must land first.** The async bidirectional design requires the *parent* (the main Sunny thread) to be a durable run that suspends on a hook and is woken by `resumeHook`; that is exactly what `durable-main-loop` builds. Building child↔parent messaging beforehand would mean wiring it into the in-process `TurnDispatcher` that `durable-main-loop` is retiring — throwaway work against a non-durable parent. Children themselves can already be durable (Tier-2 jobs exist today); it is the parent side this change waits on.

The `output_target` + `model` parameters (the quick wins, including silencing the 2am job) operate on existing Tier-2 machinery and are *not* gated on `durable-main-loop`, but are kept here for one coherent delegation story per the owner's decision.

## Impact

Builds on **durable-main-loop** (durable hook-driven parent + the `resumeHook`/`prepareStep` steering seam), **agent-tooling** (least-privilege toolsets via the per-tool credential whitelist), **security-permissions** (the no-credential untrusted-content pattern), and **observability** (child spans/runs). Touches the Tier-2 job definition, the conversational-turn workflow, the durable parent↔child link store, and tool wiring for `delegate_task` / message-a-child / output-target routing.
