## Why

Some tasks are big enough to blow out a single context window or risky enough that they should run with fewer privileges than the main agent. Bounded, least-privilege delegation lets Sunny farm out work to isolated children — preserving its own context and containing untrusted-content processing — without giving those children the keys to the kingdom.

## What Changes

Add the **subagents** capability (originally Phase 7 of `bootstrap-sunny`): a `delegate_task` tool that spawns an isolated-context child with a restricted (subset) toolset and a result-only return; concurrency/depth bounds; least-privilege enforcement with durable (Tier-2) delegation and child spans/trajectories in observability; and the pattern of delegating untrusted-content processing to a no-credential, no-high-consequence-tool child.

## Capabilities

### New Capabilities
- **subagents** — bounded, least-privilege delegation: isolated context, restricted toolset, result-only return, concurrency/depth caps, durable + observed.

## Impact

Builds on **durable-execution** (durable delegation), **agent-tooling** (least-privilege toolsets via the per-tool credential whitelist) and **security-permissions** (the no-credential untrusted-content pattern), and **observability** (child spans/trajectories).
