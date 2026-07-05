# Subagent Text Unification

## Why

The text-delivery migration (PR #31, merged) made the conversational turn text-native: the model's final text IS the reply, silence is the `<no-reply/>` sentinel parsed from text, and `send_message` is gone from the turn. The rationale (PR #30's experiments, `evals/REPORT-2026-07-03-elicitation-experiments.md`) is that tool-mediated speech fights LLM training — models are strongly trained that final text answers the caller — and measured 100% delivery for text-as-reply vs ~28% for the tool under poisoned history. Tier-2 jobs were already text-native (`finalAssistantText` + terminal deliver). That leaves exactly ONE seat still speaking through a tool: the delegated subagent, whose `send_message` ("report to your orchestrator") is its report channel and whose prompt says everything else it writes is private. One paradigm for every run profile — your text is what you say — is simpler to reason about, deletes the last `SEND_MESSAGE_SPEC` binding, and aligns the child's report with the same trained prior that made the conversation turn reliable.

Honesty note: the strongest PR #30 evidence (history self-poisoning in a rolling window) applies WEAKLY to children — a child is a one-shot context whose only input is its brief, so it never imitates its own poisoned history. The case here rests on consistency (one paradigm, less code, one delivery classification), on deleting an entire tool spec, and on the trained-prior alignment of the final report itself — the child already ends with text naturally; today that text is discarded unless it remembered to call the tool, which is why `subagent.ts` already carries a final-text fallback. This change promotes the fallback to the contract.

## What Changes

- **The child's final text becomes its report** — the one deliverable, delivered terminally to the parent's inbox via the existing `deliver({kind:'parent'})` bus call, exactly like a Tier-2 job's result (`finalAssistantText`, `recoverOnMiss: rawtext`). The current "did it send_message? then don't double-emit" branch disappears; the terminal emit is unconditional (still suppressed on `cancel_run`, unchanged).
- **`send_message` is removed from the child toolset** (**BREAKING** for the child's tool surface): `buildChildTools` drops the report tool; the `none` toolset becomes genuinely tool-less. With the conversation turn already text-native, this deletes the last consumer of `SEND_MESSAGE_SPEC`'s report seat.
- **Mid-task progress reports are replaced by structured `<report>…</report>` sentinel blocks** parsed out of the child's interim text: a child that has something worth telling its parent mid-task writes a report block; the run shell extracts and delivers each block to the parent as it completes a step. Follows the `<no-reply/>` precedent — parsing structured intent out of text goes WITH training (measured 20/20) — rather than adding a translator (children have no live human audience; a cheap-model relay adds cost and noise for a reader that can simply wait).
- **"Nothing to report" is the `<no-report/>` sentinel** as the child's entire final text — the child's analogue of `<no-reply/>` — for children whose work is fire-and-forget or whose result turned out empty. A sentinel-only final delivers nothing; the parent still gets link closure semantics (watchdog/failure events unchanged).
- **`buildSubagentPrompt` is reframed for text**: same compact-structured-report contract (the answer, not a transcript; no raw tool output), but "your final text IS your report" replaces "send_message is your ONLY way to communicate"; the progress-block and `<no-report/>` conventions are specified in the prompt.
- **Steering is untouched**: parent→child via the `message` tool and `loadSteersStep` folding are out of scope.

## Capabilities

### New Capabilities

(none — this modifies existing durable-run behavior; no new capability spec is warranted)

### Modified Capabilities

- `durable-execution`: the child-report requirements change — a `parent`-audience run's report is its final text delivered terminally through the bus (not messages emitted via a report tool); mid-task progress becomes sentinel-delimited report blocks parsed from text; a child signals "nothing to report" with a sentinel; the child toolset no longer includes a messaging tool.

## Impact

- **Code**: `workflows/subagent.ts` (drop `SEND_MESSAGE_SPEC` import + report tool; unconditional terminal deliver; interim `<report>` extraction), `src/agent/prompt.ts` (`buildSubagentPrompt` rewrite), `src/agent/delivery.ts` (report/no-report sentinel constants + parser, sibling of `stripNoReply`), `workflows/runShell.ts` (a small hook or shared helper for extracting interim report blocks at step boundaries). `src/agent/delegation.ts` / `delegationSupervisor.ts` unchanged (transport, attribution, watchdog are channel-agnostic).
- **Deletions unlocked**: with the conversation turn's tool mode already retired (parallel cleanup), `SEND_MESSAGE_SPEC` and the in-process `tools/sendMessage.ts` binding lose their last consumers and can be deleted.
- **Tests/evals**: workflow tests for the child profile (report extraction, sentinel, cancel suppression); the delegation eval cases that assert `send_message`-based reporting move to text assertions.
- **Not affected**: parent-side rendering (`reportToParent`'s `Name (subagent): text` attribution is unchanged — only what feeds it changes), steering, spawn caps, authority attenuation, Tier-2 jobs.
