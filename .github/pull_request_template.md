<!--
Definition of done for Sunny (see AGENTS.md → "Testing & evals"). The deterministic
suite is the merge gate; evals are off the gate, so the eval scorecard is recorded
HERE because CI can't run it.
-->

## What & why

<!-- Brief description of the change and its motivation. -->

## Definition of done

- [ ] Deterministic suite green locally: `npm run typecheck && npm run test && npm run test:integration`
- [ ] New/changed behavior has matching unit/integration tests (see the change-type table in AGENTS.md)
- [ ] Bug fixes include a regression test (fails before the fix, passes after)
- [ ] If **agent behavior** changed (prompt, loop, tool, model, memory wiring): eval case added/updated, `npm run eval` run, and the scorecard delta pasted below — otherwise check "N/A"
  - [ ] N/A: no agent-behavior change
- [ ] No silent coverage drop for the code this PR touches

## Eval scorecard delta

<!--
If agent behavior changed, paste the `npm run eval` scorecard (or its delta vs the
committed evals/baseline.json) here. Re-baselining is an explicit, reviewed change in
THIS PR. Otherwise: "N/A: no agent-behavior change".
-->

```
N/A: no agent-behavior change
```
