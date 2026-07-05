# Design: Subagent Text Unification

## Context

After PR #31 the codebase has two speech paradigms left:

- **Text-native** (conversation turn, Tier-2 jobs, scheduled jobs): the model's final text IS the deliverable. The conversation turn parses structured intent out of text (`<no-reply/>` → silence) and delivers final text as bubbles; jobs deliver `finalAssistantText` terminally through the one bus (`deliver`, run-audiences D-RA15).
- **Tool-mediated** (delegated subagents only): `workflows/subagent.ts` gives every child a `send_message` bound to `deliver({kind:'parent'})`, described as "the ONLY way to communicate back; your other text is private" (`buildSubagentPrompt`). The child may call it for progress updates and must call it for its result.

The subagent seat is already half-migrated in practice: `runSubagent` carries a fallback — if the child ended without any `send_message`, its final text is delivered to the parent (`finalAssistantText` + the `(the subagent produced no result)` placeholder). That fallback is production-proven; this design promotes it to the contract and deletes the tool.

Empirical grounding (PR #30/#31): text-as-reply measured 100% delivery vs ~28% for tool-mediated speech under poisoned history; the `<no-reply/>` sentinel (structured intent parsed from text) measured 20/20; and with adaptive thinking ON, multi-step runs produced ZERO interim narration text (the model narrates into private reasoning) — a finding that directly constrains any design leaning on passive interim text.

What is deliberately NOT reproduced here: the conversation turn's Haiku progress translator and the recovery model pass. Both exist because a human is waiting on an iMessage thread. A child's audience is another agent that (a) does not experience latency anxiety and (b) is robust to imperfect prose.

## Goals / Non-Goals

**Goals:**
- One speech paradigm for every run profile: what a run says is its text.
- Child final report = final assistant text, delivered terminally via the existing `deliver({kind:'parent'})` bus call — byte-for-byte the job pattern.
- A text-native replacement for mid-task progress reports (capability parity with today's multiple `send_message` calls).
- A text-native "nothing to report" signal (sentinel precedent).
- Delete the child's `send_message`; unlock full deletion of `SEND_MESSAGE_SPEC` once the parallel conversation-tool-mode cleanup lands.
- `buildSubagentPrompt` keeps the compact-structured-report contract, reframed for text.

**Non-Goals:**
- Steering (parent→child via the `message` tool, `loadSteersStep` folding) — unchanged.
- Parent-side rendering and transport: `reportToParent` attribution (`Name (subagent): text`), `appendInterRunMessage`, wake semantics, watchdog failure events, spawn caps, authority attenuation — all unchanged. Only what FEEDS `deliver({kind:'parent'})` changes.
- A translator/relay model for children (see Decisions).
- A recovery model pass for children (see Decisions).
- Conversation-turn or job changes of any kind; openspec/specs sync for the conversation cleanup (parallel branch).

## Decisions

### D1. The final text IS the report (job-style terminal deliver)

`runSubagent` drops the `extractSends` / "did it already report?" branch: after the loop, extract `finalAssistantText`, parse sentinels (D3), and — unless the parent cancelled (existing `linkRunningStep` guard, unchanged) — deliver it terminally via `deliver({kind:'parent', …})`.

*Why:* this is exactly `runJob`'s shape, it is the trained prior (a model finishing a task ends with the answer as text), and it is already the production fallback path. The conditional double-emit logic exists only because two channels exist; with one channel it disappears.

*Alternative considered — keep the tool:* rejected. The child is the last tool-speech seat; keeping it preserves two delivery classifications, two prompt contracts, and `SEND_MESSAGE_SPEC` forever, for no measured benefit.

### D2. Mid-task progress = explicit `<report>…</report>` blocks parsed from interim text

A child that has something worth telling its parent before it finishes writes a report block as visible text between tool calls:

```
<report>Two of the five sources are paywalled; proceeding with the other three.</report>
```

The run shell (subagent profile only) scans each step's freshly generated text parts for complete blocks at step boundaries — the same journaled-cursor pattern as the translator fold in `streamAgent` (`translatorCursor` over `steps[].content`) — and delivers each block's content via the memoized `deliver({kind:'parent'})` step, so replays never re-send. Blocks appearing in the FINAL text are stripped from the terminal report if already delivered (dedup by cursor position, not content). Implementation lands as a second optional hook in `streamAgent` (sibling of `TranslatorConfig`, e.g. `reportBlocks: { send }`), so `runShell.ts` stays the one shared shell and jobs/conversation simply omit it.

*Why blocks over the alternatives:*
- **vs. a translator-style relay:** the translator solves "a human is waiting and the model narrates into private reasoning" — it summarizes involuntary exhaust. A child's parent is an agent; it does not need a Haiku narrator, and every relayed update to an IDLE parent wakes a full parent turn (`reportToParent` → `wakeThread`), so unsolicited noise is expensive on the parent side, not just in Haiku calls. Progress to a parent should be rare and deliberate — which is what an explicit written block is.
- **vs. final-text-only (no mid-task channel at all):** simplest, and honestly close to today's observed behavior — but it deletes a spec'd capability (`durable-execution` "Bidirectional asynchronous parent-child messaging": a child SHALL be able to proactively send progress) and forecloses the real uses: a long child flagging a blocker the parent can steer around, and report-then-continue work (send_message never ended the turn; final text definitionally does — blocks restore "say something and keep working").
- **vs. passive narration relay (deliver all interim text):** dead on arrival — the PR #31 grid showed thinking-mode children produce ZERO passive narration text. An INSTRUCTED block is a deliberate act the model performs when told to, like `<no-reply/>`; it does not depend on narration exhaust existing.

*Honest expectation:* block usage will be rare (most children are minutes-long one-shots, and thinking mode swallows casual narration). That is the correct frequency — the mechanism exists for the long/blocked case, and the prompt frames it as exceptional ("most tasks need no progress report"). If telemetry shows it never fires AND no capability gap materializes, deleting it later is a one-hook removal.

### D3. "Nothing to report" = `<no-report/>` sentinel as the entire final text

The child's analogue of `<no-reply/>`: a final text of exactly `<no-report/>` delivers nothing to the parent; the link still closes `done` and steers are still marked answered.

- **Distinct token** (`<no-report/>`, not reusing `<no-reply/>`): the semantics differ ("your orchestrator needs nothing from this" vs "the human gets no message") and distinct tokens keep telemetry and prompt language unambiguous. The parser is a shared generalization of `stripNoReply` (same mechanics: sentinel-only → nothing; content + stray sentinel → content delivered with the token stripped, nothing genuinely written is swallowed).
- **Empty final, no sentinel** (the miss case): fall back to the raw interim narration as the report (the D-DS14 `recoverOnMiss: rawtext` posture jobs already take) — a parent-agent reads messy raw notes better than a placeholder; if that too is empty, keep today's `(the subagent produced no result)` line. No Haiku recovery pass: the reader is an agent, a model call to prettify is waste.

*Why a sentinel at all:* children mostly SHOULD report (the parent delegated to get an answer back), but cancel-adjacent, fire-and-forget, and "checked; nothing actionable" children need an honest no-op that isn't an empty-string ambiguity. Wording-based "end with nothing" instructions measured 0/9 in the PR #31 grid; sentinels measured 20/20.

### D4. History/persistence: no new shapes

- **Parent window:** unchanged. Reports (terminal and block) arrive as they always have — `deliver({kind:'parent'})` → `reportToParent` → inbound `delegation`-channel message `Name (subagent): text` on the parent thread, folded by an in-flight parent via `loadSteers` or waking an idle one. Each `<report>` block is one such message, exactly like a progress `send_message` was.
- **Child turns:** stay unpersisted as conversation rows (status quo — `runSubagent` writes no turn record; the child's work is inspectable in the WDK runs inspector). Nothing about text mode requires changing this: the child thread is a detached steering inbox, not a history the child re-reads — which is also why the rolling-window poisoning argument doesn't apply to children, and why no `data-translator`-style persisted parts are needed.
- **Delivery classification:** child outcomes get the text-mode vocabulary for telemetry (`text` / `silence` / `fallback_text` from a `classifyTextDelivery`-shaped helper) so dashboards read one language across profiles.

### D5. `buildSubagentPrompt` reframed for text

Keep: role framing ("delegated subagent of Sunny, working as <label>, ONE focused task, no human watching, no follow-up questions"), real-tools admonition, boundaries line, memory core. Replace the "How you report" block:

- "Your FINAL text is your report — it is delivered to your orchestrator verbatim when you finish. End your turn on the report itself."
- Compact-structured contract kept verbatim in spirit: "a COMPACT, STRUCTURED summary — the answer, not a transcript; do NOT paste raw tool output; state what you found / did and any caveats, briefly."
- Progress blocks: "Most tasks need no progress report. For a genuinely long task, or when you hit something your orchestrator should know now (a blocker, a surprise), write `<report>…</report>` on its own lines mid-task — its content is delivered immediately and you keep working. Everything outside these blocks and your final text is private."
- Sentinel: "If there is genuinely nothing your orchestrator needs back, make your entire final text `<no-report/>`."

### D6. Migration and the `SEND_MESSAGE_SPEC` endgame

1. Ship this change: `buildChildTools` drops the report tool (`none` toolset becomes `{}` — genuinely tool-less), `runSubagent` gains sentinel/block parsing and the unconditional terminal deliver, prompt + specs updated.
2. In-flight children at deploy: children are run-to-completion and minutes-long; deploy at an idle moment or accept that a rare in-flight child fails replay and surfaces via the existing watchdog failure event (the parent is told and can re-delegate). No dual-mode knob — unlike PR #31 there is no human-facing risk to hedge, and the terminal-deliver path being promoted is already the live fallback.
3. After the parallel conversation-cleanup branch lands (tool mode deleted from the turn): `SEND_MESSAGE_SPEC`, `src/agent/tools/sendMessage.ts`, and the child-report seat of `extractSends` have no consumers — delete them (tracked as a task here, gated on that branch).
4. Rollback: `git revert` (single small commit surface; no schema, no config).

## Risks / Trade-offs

- **[Weak poisoning rationale] The strongest PR #30 evidence doesn't apply to one-shot child contexts** → acknowledged head-on: the justification is consistency (one paradigm, one classification vocabulary), deletion (`SEND_MESSAGE_SPEC` and the last dual-channel branch), and trained-prior alignment of the final report — plus the fact that the promoted path is already the proven production fallback. The diff is small and reversible; if the eval gate shows regression, we simply don't merge.
- **[Report-then-continue regression] `send_message` didn't end the turn; final text does** → `<report>` blocks restore mid-task speech; the prompt names the pattern explicitly.
- **[Blocks may never fire] thinking-mode children write no casual interim text** → blocks are instructed acts, not narration exhaust; low usage is acceptable by design; telemetry (count block deliveries) tells us if the mechanism is dead weight.
- **[Sentinel/block collision] a child quoting literal `<report>` or `<no-report/>` in content** → same posture as `<no-reply/>`: weird verbatim tokens chosen to be improbable; parser only treats a sentinel-only final as silence and only complete `<report>…</report>` pairs as blocks; worst case is a stray token stripped from delivered text, never a swallowed report.
- **[Verbose finals] no tool schema pressure toward compactness** → compactness was always prompt-enforced (the tool description merely repeated the prompt); the parent inbox is an internal thread with no bubble-length constraints, so a long report degrades quality, not delivery. Eval asserts the compact contract.
- **[Eval drift] delegation evals assert `send_message`-based reporting** → the delegation/tool-selection eval cases move to text assertions in the same change; gate before merge.

## Migration Plan

Covered in D6. Order: land this change → verify with the delegation eval cell + a live smoke (`delegate_task` from the owner DM; confirm attributed report arrives, `list_runs` shows closure) → after the conversation-cleanup branch merges, do the `SEND_MESSAGE_SPEC` deletion task → devbox service restart (HMR staleness, per ops memory).

## Open Questions

- Should `<report>` block delivery SKIP the parent wake for an idle parent (append without `wakeThread`), reserving wakes for the terminal report? Waking per progress block re-creates the expensive-noise problem the translator decision avoids; but a blocker report arguably WANTS a wake. Default in this design: keep the existing wake behavior (blocks are rare and deliberate, and a blocker is exactly the wake-worthy case); revisit if telemetry shows wake churn.
- Does the (future) orchestrator-child profile need anything more than this? An orchestrator synthesizing grandchildren reports would fold them as steers — no new channel needed — but its own upward reports ride the same block/final contract. No design change anticipated; flagging for the eventual orchestrator change.
