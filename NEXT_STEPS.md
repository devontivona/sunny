# NEXT_STEPS.md

Prioritized follow-ups captured before a context compaction. Phases 0–3 are
implemented and live (Sendblue iMessage loop, files-first memory, durable Tier-2
jobs, self-scheduling, idempotent ack-fast turns + double-text steering). See
`README.md` (deploy/run) and `AGENTS.md` (gotchas). These are the next things to
do; everything else is deferred to a later build.

---

## 1. Implement cache controls (tasks 3.5 / 3.9) — ✅ DONE (2026-06-17)

**Implemented:** `src/agent/loop.ts` now passes `instructions` to `ToolLoopAgent`
as a `SystemModelMessage` with `providerOptions.anthropic.cacheControl =
{ type: 'ephemeral' }`, caching the stable prefix (tools + system + memory core)
at the 5-min TTL; the recent window stays the uncached suffix. The turn log gained
`cacheWriteIn` (from `totalUsage.inputTokenDetails.cacheWriteTokens`) alongside the
existing `cachedIn`. Verified with a real-model probe: step 1 wrote ~14.8K cache
tokens, step 2 read them back (`cachedInputTokens`). No cross-turn machinery, as
planned. tasks.md 3.5/3.9 checked.

Original notes (kept for context):

**Goal:** cache the stable system prefix so multi-step turns stop re-paying full
input price on every step. Verify with `cachedIn > 0` (already logged per-turn in
`src/agent/loop.ts` → `logTurnSummary`).

**Pricing (claude-opus-4-8):** input $5/MTok, output $25/MTok; cache **write 1.25×**
(5-min TTL) / 2× (1-hr); cache **read 0.1×**; **min cacheable prefix 4096 tokens**.
Our prefix is ~5–7K tokens (system instructions + 7 tool schemas + memory core),
so it's above the floor. Real turns observed: 1-step ≈ 7.5K input; 2-step ≈ 16.7K.

**Recommendation (R2 — do this, skip cross-turn machinery):**
- Mark the **stable prefix** `cache_control: { type: 'ephemeral' }` (default 5-min TTL).
  In `src/agent/loop.ts`, pass `instructions` to `ToolLoopAgent` as a
  `SystemModelMessage` (not a bare string) with
  `providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }`.
  Verify the exact field shape against the `ai-sdk` / `@ai-sdk/anthropic` skill
  before writing (the provider supports `cacheControl` on message parts).
- **Breakpoint placement:** render order is tools → system → messages. Marking the
  system message cacheable caches tools+system+memory-core together (the stable
  prefix); the recent-window messages remain the uncached volatile suffix. That's
  the correct split — do NOT cache the recent window.
- **Do NOT** use the 1-hr TTL, pre-warming, or a re-warm cron (that's the
  cross-turn machinery we deliberately skip — low payoff for a single sporadic
  user, and our memory-core-in-prefix changes frequently so cross-turn hits
  often miss anyway).
- **Byte-stability:** `buildSystemPrompt` must stay deterministic (no timestamps/
  UUIDs; deterministic tool order). It is today. Memory writes change the *next*
  turn's prefix (expected cache miss across turns; within-turn is safe because the
  prefix is built once at turn start).

**Expected effect:** ~33% off the prefix on a 2-step turn, ~60% on a 4-step turn;
small write-premium loss on isolated single-step turns (acceptable). Grows much
more valuable as the prefix grows (bigger memory, Phase 5 skills metadata).

**Verify:** after wiring, a multi-step turn should log `cachedIn > 0`.

---

## 2. Fix the `send_message` elicitation slip — ✅ DONE (2026-06-17)

**Implemented:** `toModelMessages` in `src/agent/loop.ts` now reconstructs each of
Sunny's past replies as a `send_message` tool-call + `delivered` tool-result pair
(synthetic `toolCallId = send-${messageId}`) instead of a plain assistant text
turn, so the model's own history shows that speaking == calling `send_message`.
The trailing-trim was widened to drop trailing non-user messages (assistant + tool)
so the prompt still ends on a user message. The telemetered fallback is kept as the
safety net. Verified with a real-model probe: the reconstructed tool history is
API-valid (no 400) and a follow-up that probed elided reasoning elicited a
`send_message` call (not plain text). Send-only reconstruction (non-send tools
aren't stored) — intentional, it sharpens the signal.

**Follow-up — now specced as Phase 3.5 / D-MG9 (current priority):** retaining
cross-turn *context* (the reasoning Sunny elides from terse iMessage replies). Decided
design: persist **one AI SDK `UIMessage` per row = one turn** (envelope + `jsonb`
payload + `text` projection), retain Sunny's plain-text scratchpad as a `UIMessage`
text part, skip native Anthropic reasoning. Supersedes this item's synthetic
reconstruction. See `design.md` D-MG9 and `tasks.md` §5 (Phase 3.5).

Original notes (kept for context):

**Symptom:** the model sometimes writes its reply as ordinary (private) text
instead of calling `send_message`. The telemetered safety net in
`src/agent/loop.ts` then delivers it and logs
`agent:loop: no send_message; delivering scratch text as fallback` with
`delivered: 'fallback_text', sendCount: 0`. Watch that line — it should trend to ~0.

**Already done:** strengthened the system prompt (`src/agent/prompt.ts`) to frame
ordinary text as a private scratchpad and `send_message` as the only channel.
That fixed the majority of cases (verified the model now calls `send_message`
multiple times and continues interviews), but it still slips occasionally.

**Recommended structural fix (the part we deferred):** render Sunny's *prior*
replies in the model message history as `send_message` tool-call + tool-result
pairs, instead of plain `assistant` text. Today `toModelMessages` in
`src/agent/loop.ts` emits past Sunny replies as `{ role: 'assistant', content }`,
which teaches the model to reply in text. Emitting them as a `send_message`
tool-call (assistant) + tool-result (`delivered`) makes its own track record
demonstrate the pattern.
- Verify the exact AI SDK v6 `ToolCallPart` / `ToolResultPart` `output` shape
  (e.g. `{ type: 'text', value: 'delivered' }`) before writing.
- **Interacts with the trailing-assistant-trim** already in `runTurn` (the prompt
  must end with a user message — Anthropic rejects ending on assistant). With
  tool-call history, adjust the trim to drop trailing assistant/tool turns so the
  prompt still ends on the last real user message. Re-test.
- Keep the telemetered fallback as a safety net.

**Verify:** re-run the local probe (real model, interview prompt) — confirm
`sendCount > 0`, no `fallback_text`, and steering still folds.

---

## 3. Migrate Tier-2 job durability to `DurableAgent` — ✅ DONE (2026-06-17)

**Implemented:** both `workflows/scheduledJob.ts` (`runScheduledJob`) and
`workflows/job.ts` (`runJob`) now run a `DurableAgent` (`@workflow/ai/agent`) at the
`"use workflow"` level instead of a single `"use step"` `generateText`/`ToolLoopAgent`
— so each LLM call (and tool call) is a durable step with mid-run resume. Model via
`@workflow/ai/anthropic`'s lazy factory (`anthropic('claude-opus-4-8')`, uses our
direct API key); thinking config carried via `providerOptions`; final text pulled
from `result.messages`. `runScheduledJob` keeps **memory-tools-only** (anti-recursion
D-SC4) and its tool `execute` is **step-wrapped** so a replay never re-applies a
non-idempotent `memory_write` (the specs were extracted to a Node-free
`memorySpecs.ts` so the workflow sandbox can import them). `runJob` has no tools yet
(single durable generation); Phase 4 tools slot in as step-wrapped executes.
Verified: typecheck + the workflow compiler builds it ("2 workflows, 17 steps") +
clean runtime startup. Live durable-run + crash-resume not exercised here (needs a
real trigger). tasks.md 4.2/4.3 carry the granularity note.

Original notes (kept for context):

**Current state:** `workflows/job.ts` (`runJob`) and `workflows/scheduledJob.ts`
(`runScheduledJob`) run the work as a single `generateText` / `ToolLoopAgent`
call inside one `'use step'`. Durability is therefore **workflow-level only** — a
crash re-runs the whole work step from scratch, not mid-agent step-level resume.

**Goal:** use `DurableAgent` from `@workflow/ai/agent` (already installed) so the
agent loop itself is durable — each LLM step / tool call becomes a workflow step
that survives a mid-agent crash and resumes from the last completed step (true
D-DE1/2). 

**How (verify against the `workflow` skill + `@workflow/ai` docs — it's
experimental):**
- `DurableAgent` runs inside the `'use workflow'` function directly (it manages
  the sandbox itself — not wrapped in a `'use step'`). Tool `execute` fns that
  need Node access use `'use step'`.
- Confirm how `DurableAgent` takes the model — the doc example used a gateway
  string (`"anthropic/claude-haiku-4.5"`); check whether it accepts our
  `anthropic('claude-opus-4-8')` instance or needs the gateway-string form.
- `agent.stream({ messages, writable })` wants a `getWritable()` target; we don't
  need user-facing streaming — use the final `result.messages`/result and deliver
  via the existing `deliver` `'use step'` (gateway proactive send).
- **Preserve constraints:** `runScheduledJob` must keep **memory-tools-only**
  (no `send_message` / schedule / `start_job`) — anti-recursion (D-SC4) + least
  privilege. The `deliver` + `recordRun` steps stay.
- Apply to **both** `workflows/job.ts` and `workflows/scheduledJob.ts`.

**Caveat:** `@workflow/ai` is experimental/active-development. The current
single-step approach is already restart-durable; `DurableAgent` only adds finer
mid-agent resume. Weigh the complexity. Validate end-to-end with the (gated)
`/debug/job` route and `npx workflow inspect runs` as before.

---

## OpenSpec documentation cleanup (implemented vs deferred)

Before archiving the `bootstrap-sunny` change, reconcile the artifacts with what
was actually built. Run `/opsx:sync` / `/opsx:archive` only after these:

**design.md**
- **Transport** is Sendblue (`chat-adapter-sendblue`), not Photon/Spectrum
  (`vercel-chat-adapter-imessage` / `spectrum-ts`). Already swept across
  design/proposal/specs/tasks/config.yaml — re-verify no stale Photon/Spectrum
  refs remain.
- **Project skeleton / D-PS6:** the run pipeline is **Nitro** (`workflow/nitro`
  compiles the WDK `"use workflow"`/`"use step"` directives) — `nitro dev` in dev,
  `nitro build` + `node .output` in prod. There is no bare-`tsx` path. **devbox**
  is the supervisor (systemd user service, `Restart=always` + linger → boot
  survival); 4.0 is satisfied by devbox, not a hand-rolled systemd unit. The
  `nitro build` → `.output` production hardening is deferred. Update D-PS1/D-PS6
  to say this.
- ✅ **D-MG8 (output model)** — done (D-MG9 commit `ac60e68`): refreshed to the
  as-built telemetered fallback + history-as-tool-calls reinforcement; 2.5a task
  wording carries a one-line as-built note.
- **D-SC6 (cost/rate caps):** only a per-tick rate guard (`MAX_PER_TICK`) exists;
  full per-run cost/token caps + scheduler rate limit are **deferred to Phase 6**
  (observability budget meter). State that enforcement lives in Phase 6.
- **4.1b steering** as built: folds a mid-run message via `prepareStep` on
  **multi-step turns**; a message during a 1-step turn becomes a follow-up turn
  (both answered). The `abortSignal` restart for *task-invalidating* messages and
  a **debounce** to batch rapid single-step texts are **not** implemented —
  note as deferred. Also note the trailing-assistant-trim requirement (prompt must
  end on a user message).
- ✅ **4.2/4.3 durability** — now `DurableAgent` step-level (item 3 done); update the
  D-DE2 wording to reflect mid-run resume rather than whole-step re-run.

**specs/**
- ✅ `messaging-gateway` "Guard against unintended silence" — done (D-MG9 commit):
  rewritten to fallback-delivery + history-reinforcement; also added the
  "Turn-grained transcript with retained working context" requirement.
- `agent-memory` keyword-recall: clarify summarization is **in-context** (the
  main model summarizes `recall_history` matches; no dedicated summarizer call).
- `scheduling` cost/rate-limit requirement: note enforcement is Phase 6.

**tasks.md**
- 4.0 checked with the devbox note already added (3.5/3.9 now checked — caching done).
- Phase 3.5 (§5) is the active in-progress section.

**Minor / dev-only**
- `server/routes/debug/job.post.ts` (gated by `SUNNY_DEBUG`, off in prod) is not
  in the spec — keep as a dev tool or remove before archiving.
- Confirm the vendored `chat-adapter-imessage` + `vendor/` are fully gone
  (migrated to Sendblue) — done; re-verify.

**Whole later phases (not "cleanup", just not started):** Phase 4 (security,
1Password/credentials, bash + command permissioning, taint-tracking), Phase 5
(skills), Phase 6 (observability: OTel, trajectories, budget meter, audit log),
Phase 7 (subagents), and 10.1 backups (scheduled `git` commits of `~/.sunny` +
`pg_dump`).
