> Build plan for the subagents change (originally Phase 7 of `bootstrap-sunny`).
> D-* decisions are in this change's `design.md`.

- [ ] 1 `delegate_task`: isolated-context child, restricted (subset) toolset, result-only return (subagents R: delegation; D-SUB1/3).
- [ ] 2 Bounds: concurrency cap (default 3), depth cap (default 2), no sub-delegation unless orchestrator (subagents R: bounded; D-SUB2).
- [ ] 3 Least-privilege enforcement + durable delegation (Tier-2) + child spans/trajectories in observability (subagents R: least-privilege, durable/observed; D-SUB3/4/6).
- [ ] 4 Pattern: delegate untrusted-content processing to a no-credential, no-high-consequence-tool subagent (subagents D-SUB5).
