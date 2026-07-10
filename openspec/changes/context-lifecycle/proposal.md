# Proposal: context-lifecycle

## Why

The 2026-07-09 financial-advisor session exposed the context architecture's failure modes end to end: attachments became unreachable once evicted from the 30-row window (Sunny claimed re-sent PDFs were "gone" while they sat on disk); facts read from emails/documents were unfindable by recall (the `text` projection never indexes tool output); the window itself is economically broken (~170k tokens covering only ~4h on a tool-heavy thread, ~350–400k uncached tokens per model step at 2× long-context pricing); a comprehensive topic doc was invisible because its INDEX line — pure convention, unenforced — was never written; and the nightly memory-consolidation job is structurally blind (its only input is its own schedule prompt; it has no affordance to read conversation history, so every "nothing to consolidate" since June was literally true).

## What Changes

- **Reachability**: evicted context becomes one hop away instead of gone —
  - `memory_write(topic:…)` deterministically ensures an INDEX.md line (stub hook appended in the same serialized write) — orphaned topics become impossible.
  - `recall_history` results carry attachment names + saved disk paths; the media prompt states that inbound files persist and how to re-read them (drops the "you have NO tool to open it" phrasing).
  - The `text` projection additionally indexes tool-result text (sanity-bounded, base64-stripped); recall displays `ts_headline` snippets instead of whole rows; a new `recall_expand(messageId)` memory tool deep-fetches one full row on demand.
- **`sunny` CLI (new, generic)**: a repo-owned self-interaction CLI (`src/cli/`, invoked via `npx tsx` over bash) — the composable surface for capabilities that don't warrant native tools. This change ships the frame plus the `dream` subcommands (`digest` / `compact` / `advance`); future capabilities land as subcommands documented by skills.
- **Dreaming job (replaces nightly consolidation)**: a pre-seeded scheduled job (label `dreaming`, every 4h, silent/household, authority `memory_read, memory_write, bash, file_read`) whose procedure lives in a new `skill:dreaming`. It digests all conversation since the last dream watermark (via `sunny dream digest`), updates USER/SUNNY/people/topic docs, reconciles the INDEX lint diff, and writes per-thread compaction summaries (via `sunny dream compact`, which owns the correctness-critical validations). No new workflow profile, no new native tools for the job itself.
- **Window compaction (read-time overlay)**: window assembly replays [latest compaction summary] + [verbatim post-watermark tail] instead of raw evicted rows. Raw rows are never deleted or mutated. The verbatim tail targets ~100k tokens (config). Prompt-cache breakpoints added at the summary and window tail (alongside the existing system breakpoint).
- **Removed**: the `nightly-consolidation` seeded schedule (superseded by `dreaming`).

## Capabilities

### New Capabilities
- `context-compaction`: per-thread compaction summaries written by the dreaming job (watermark semantics, validation invariants, summary contract) and consumed by window assembly as a read-time overlay with cache breakpoints.
- `sunny-cli`: the generic repo-owned self-interaction CLI — invocation contract, subcommand structure, and the `dream digest|compact|advance` commands.

### Modified Capabilities
- `agent-memory`: topic-INDEX linkage becomes a deterministic write-path invariant; recall returns snippets + attachment refs with a `recall_expand` deep-fetch; the FTS projection includes bounded tool-output text; the memory-consolidation requirement is re-stated as the dreaming job (history-fed, every 4h) instead of the blind nightly pass.
- `scheduling`: the seeded maintenance schedule becomes `dreaming` (4h cadence, bash-bearing authority, skill-driven prompt); the nightly-consolidation seed requirement is retired.
- `messaging-gateway`: the conversation window requirement changes from "last N rows verbatim" to "compaction summary + verbatim tail (token-targeted), raw rows immutable and reachable".

## Impact

- **Code**: `src/memory/index.ts` (INDEX invariant), `src/agent/tools/memory.ts` + `memorySpecs.ts` (`recall` rendering, `recall_expand`), `src/agent/prompt.ts` (media/memory sections), `src/gateway/store.ts` (recall snippets, watermark-aware `recentWindow`, `latestCompaction`), `src/dashboard/data.ts` (search snippets), `workflows/conversation.ts` (projection with tool extracts; summary prepend + cache breakpoints in `loadPending`), `workflows/runShell.ts` (memory_read bundle), `src/scheduler/index.ts` + `src/runtime.ts` (dream schedule seed), `src/config/index.ts` (knobs), `src/agent/tools/catalog.ts`. New: `src/cli/` (frame + dream subcommands), `skill:dreaming` seed + live authored copy.
- **Schema**: migration 0012 — `thread_compactions`, `dream_state` tables (auto-applied at boot).
- **Data/ops**: legacy `nightly-consolidation` schedule row deleted on first boot; one deploy restart; dream fire verified post-deploy.
- **Cost**: per-step input tokens on heavy threads drop from ~350–400k toward ~120k base + cached prefixes; the dream itself costs a few dollars/day on Sonnet (idle runs pennies), paid for several times over by the window savings.
