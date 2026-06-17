> Build plan for bootstrap-sunny. Optimized to reach a **live, testable iMessage
> loop as fast as possible** (Phase 1, Milestone B: "text Sunny → get a real Opus
> reply"), then layer intelligence-visible capabilities one phase at a time so each
> step is observable on the live agent. Heavy infra (Postgres, 1Password, systemd)
> is deferred to the phase that first needs it — it is NOT required for the first
> reply. Each group references its spec under `specs/<capability>/` and the design
> decisions (D-*) in `design.md`.

## 1. Phase 0 — Minimal foundation (just enough to text Sunny)

- [x] 1.1 Scaffold the Node LTS + TypeScript project (D-PS1): `package.json`, `tsconfig`, the `src/` layout (D-PS2), lint/format, env loading.
- [x] 1.2 Install/pin the loop's core deps only: `ai` (v6), `@ai-sdk/anthropic`, `chat`. (Drizzle/Postgres → Phase 2; `@workflow/world-postgres` → Phase 3; `@1password/sdk` → Phase 4; OTel → Phase 6.)
- [x] 1.3 **Critical path to "text Sunny":** Sendblue account + API key/secret in env; expose the **inbound webhook** at a public URL via **`devbox`** (set that URL as Sendblue's Receive webhook) so Sendblue can POST inbound messages in dev. *(Nice early dogfood of the same `devbox` skill Sunny uses later for hosting sites. In prod, the home server's own reachable endpoint replaces the devbox URL.)*
- [x] 1.4 Wire the model: `anthropic('claude-opus-4-8')`, adaptive thinking + effort defaults, `ANTHROPIC_API_KEY` from env (D-PS3).
- [x] 1.5 `~/.sunny/` config loader (non-secret settings) + create the runtime dir (D-PS5). *(The single `~/.sunny/` git repo for memory+skills lands with Phase 2.)*

> Deferred out of Phase 0 (moved to where they're first needed): local Postgres + Drizzle → Phase 2 · 1Password vault/Service Account → Phase 4 · systemd always-on deploy → Phase 3. The skeleton runs **foreground in dev** with env-var secrets.

## 2. Phase 1 — Walking skeleton (the fast path to a live loop)

- [x] 2.1 Define the normalized `Gateway` seam: `ChannelEvent` inbound, `send()` outbound, `capabilities` (messaging-gateway R: normalized interface, D-MG1/3).
- [x] 2.2 Implement the iMessage driver via Chat SDK + Sendblue adapter; HTTP webhook listener for inbound (D-MG1, D-MG7). **→ Milestone A: gateway echo — text Sunny, it echoes back (no LLM yet; proves the transport round-trip independent of the agent).**
- [x] 2.3 Trivial conversation store (in-memory or local SQLite) for recent-window context. **Promote to Postgres in Phase 2** — the skeleton does not need Postgres (messaging-gateway R: self-owned store, D-MG2).
- [x] 2.4 Sender authorization: allowlist Devon's identity at the gateway (messaging-gateway R: sender authorization, D-MG6).
- [x] 2.5 In-process agent loop (`ToolLoopAgent`, Opus) that reads the recent window and talks to the user **only via a `send_message` tool** (raw model text private); adaptive thinking on. **→ Milestone B: text Sunny → get a real Opus reply. (This is the goal — from here you iterate on intelligence live.)** (D-MG8)
- [x] 2.5a Output model (D-MG8): `send_message(text)` (multi-call per turn, doesn't end the turn, idempotent on resume); **scratchpad/notes** via the memory surface for cross-step working memory; **silence = not calling send**; **system-prompt elicitation** + a **forgot-to-send guard** (messaging-gateway R: explicit send-message, unintended-silence guard). *(As-built: the forced guard was replaced by a telemetered fallback; history-as-tool-calls reinforces elicitation — see Phase 3.5 / D-MG9 for the turn-grained successor.)*
- [x] 2.6 Per-channel capability flags + graceful degradation; no token streaming (complete messages); typing indicator on turn start / per send (D-MG3, D-MG8, D-DE3).

## 3. Phase 2 — Memory

- [x] 3.0 Stand up **local Postgres + Drizzle** (schema + migrations); migrate the conversation store off the Phase-1 trivial store. Create the single `~/.sunny/` git repo for `memory/` + `skills/` (moved from Phase 0; D-PS1, D-DE4, D-PS5).
- [x] 3.1 Always-on core: load `USER.md` + `SUNNY.md` + `INDEX.md` each run; render as a byte-stable cached system prefix (agent-memory R: always-on core; D-PS4 caching).
- [x] 3.2 Memory write tool (`add`/`replace`/`remove`, no `read`); error-on-overflow forces consolidation (agent-memory R: forced consolidation, D2).
- [x] 3.3 On-demand topic docs via `INDEX.md` router; date-tagged facts for temporal reasoning (agent-memory R: topic docs, date-tagged facts; D1, D4).
- [x] 3.4 Keyword recall: Postgres `tsvector`/GIN FTS over messages + LLM summarization; rolling recent-window + recall for older (agent-memory R: keyword recall; D-OB? n/a).
- [x] 3.5 Memory-vs-skill boundary in agent instructions; verify caching with `cache_read_input_tokens > 0` (D-PS4). [Boundary in `prompt.ts` ("Memory vs. skill"); caching verified — multi-step turn re-reads the prefix at ~0.1× (`cachedIn`/`cacheWriteIn` in the turn log).]
- [x] 3.6 (Deferred-ready) define the recall interface so `pgvector` semantic search slots in later without agent-loop changes (agent-memory R: semantic upgrade path, D5).
- [x] 3.7 Cold-start/onboarding: hand-seed a starter `USER.md`; onboarding conversation that records durable facts; memory global to Devon, message window per thread (R11).
- [x] 3.8 Serialize all memory-file mutations through a single writer / advisory lock; reads snapshot-at-run-start (R7).
- [x] 3.9 Enable prompt caching; verify `cache_read_input_tokens > 0`; do not assume the always-on core is free (R2, D-PS4). [As built: the stable prefix (tools + system + memory core) is marked `cacheControl: ephemeral` (5-min TTL) on every turn via `ToolLoopAgent.instructions` as a `SystemModelMessage` — NOT conditionally "only on multi-step turns", since step count isn't knowable in advance and the multi-step/burst reads dominate the small single-step write premium. Cross-turn machinery (1-hr TTL / pre-warming) deliberately skipped (R2). Verified via probe: step 1 writes (`cacheCreationInputTokens`), step 2 reads (`cachedInputTokens`).]

## 4. Phase 3 — Durable execution & scheduling

- [x] 4.0 Go always-on: systemd unit for the `sunny` service (`Restart=always`) + Postgres service; long-lived WDK worker; document the deploy (moved from Phase 0; D-PS6). **(devbox provides systemd Restart=always + linger/boot-survival; deploy documented in README + AGENTS.md; nitro build→.output hardening deferred until dev settles.)**
- [x] 4.1 Idempotent conversational turns keyed by message id; re-process un-answered messages on restart; inbound dedup; **serialize turns per thread** (durable-execution R: idempotent turns, D-DE1; R7).
- [x] 4.1b Double-text steering: per-thread **steer-buffer** drained by AI SDK `prepareStep` so a new owner message folds into the in-flight run at the next step (not a new run, not a kill); `abortSignal` restart only when the message invalidates the task (durable-execution R: double-text steering; R12).
- [x] 4.2 WDK on `@workflow/world-postgres`; `start_job` tool that promotes long/async work to a durable Tier-2 job; side effects in `'use step'` (durable-execution R: durable jobs; D-DE1/2). [Upgraded (NEXT_STEPS #3): both Tier-2 jobs now run a `DurableAgent` (`@workflow/ai`) at the workflow level — each LLM/tool call is a durable step (mid-run resume), not one coarse step. Scheduled-job memory tools are step-wrapped (replay-safe `memory_write`); specs in Node-free `memorySpecs.ts`.]
- [x] 4.3 Single-write persistence on completion; completion notification via gateway (durable-execution R: single-write, completion notification; D-DE3).
- [x] 4.4 Scheduler: persisted schedules in Postgres (relative/absolute one-shot, interval, cron) from natural language; dispatch as Tier-2 jobs; WDK `sleep()` for one-shots (scheduling R: schedule types, durable schedules; D-SC1/2).
- [x] 4.5 Self-scheduling tool + anti-recursion guard (scheduled runs can't create schedules) (scheduling R: self-scheduling, anti-recursion; D-SC3/4).
- [x] 4.6 Scheduled output delivery + run history; missed-fire policy (one-shots catch up once; recurring no backfill) (scheduling R: output delivery; D-SC5).
- [x] 4.7 Wire the nightly memory-consolidation job as the first recurring schedule (agent-memory D3 × scheduling).

## 5. Phase 3.5 — Turn-grained transcript & working-context retention (current priority)

> Inserted mid-build (before Phase 4) per decision **D-MG9**. Reworks the conversation
> store to persist **one AI SDK `UIMessage` per row = one turn**, retains Sunny's
> plain-text working context across turns so terse iMessage replies don't lose
> follow-up context, and **supersedes the Phase-1 synthetic history reconstruction**
> (the fabricated `send_message` tool-pairs from 2.5a / item 2). The cache work (3.5/3.9)
> and the interim history-as-tool-calls fix are already in; this is the durable version.
>
> **Decisions (resolved upfront, D-MG9):** store **full** fidelity (whole assistant
> `UIMessage`, all tool parts) · replay **full** (bounded by the window; filter heavy
> tool i/o later only if noisy) · FTS `text` projection = **inbound + delivered sends +
> assistant scratch** (scratch recallable beyond the window) · `metadata` =
> `{createdAt, model, usage, delivered, steps}` (assistant) / `{createdAt}` (inbound) ·
> do **not** adopt Chat SDK `bot.transcripts`.

- [x] 5.1 Schema: rework the `messages` store to **one row per `UIMessage` (turn)** — keep the queryable envelope (`channel`, `thread_id`, `message_id`, `role`, `is_owner`, `timestamp`, `processed_at`), add a `jsonb` payload (the `UIMessage`), and keep a flattened `text` projection for the `tsvector`/GIN recall (new Drizzle migration; never edit applied ones) (D-MG9, D-DE4). [Added nullable `payload jsonb` via `0005_payload_jsonb.sql` (`drizzle-kit generate`); verified live in DB. Envelope + `text` projection already existed. The per-turn *write/read* semantics land in 5.2–5.4; legacy rows keep `payload` null.]
- [x] 5.2 Capture: switch the turn from `agent.generate()` to `agent.stream()` and assemble the assistant `UIMessage` via `readUIMessageStream(result.toUIMessageStream())`; persist payload + text projection. **Re-verify** prompt-cache logging (`cachedIn`/`cacheWriteIn`) and `prepareStep` double-text steering still hold on `stream()` (D-MG9; guards 3.9, 4.1b). [`loop.ts` consumes the UI stream → assembles the turn `UIMessage` → `store.appendTurn(payload, projection)`. `send_message` delivers `{persist:false}`; `gateway.send` gained the `persist` opt; turn metadata = `{createdAt,model,usage,delivered,steps}`. Probe confirmed cache read/write on `stream()`.]
- [x] 5.3 Inbound: construct user `UIMessage`s at ingest (`{ id, role:'user', parts:[{type:'text',…}], metadata }`); persist via the new shape; preserve inbound dedup + restart-recovery on the envelope (D-MG9, D-DE1). [`store.appendInbound` writes `userPayload(event)`; dedup/recovery unchanged on the envelope.]
- [x] 5.4 Replay: rewrite `toModelMessages` to parse stored `UIMessage` payloads → `await convertToModelMessages()`; **retire the synthetic `send_message` tool-pair reconstruction** (supersedes 2.5a); keep the trailing-trim-to-user-message rule (D-MG9). [`rowToUIMessage` uses the payload (legacy rows get a minimal fallback); group speaker-prefix applied at replay; probe confirmed the window (incl. tool-send_message parts) converts + round-trips with no 400.]
- [x] 5.5 Working-context contract: update the system prompt so plain text = **private working notes** (retained for follow-ups) and `send_message` = the only delivered channel. Verify with a real-model probe that Sunny writes useful scratch AND still sends (no `fallback_text`), and that a follow-up draws on retained context (D-MG9, D-MG8). [Send-first ordering in `prompt.ts` (scratch is explicitly an *addition, never a substitute*). NB: a first pass regressed elicitation — replaying scratch-as-text made the model answer in scratch; the send-first reorder fixed it (3/3 probe runs: sendCount≥1, genuine working-context scratch, no fallback).]
- [x] 5.6 Recall + window: write the `text` projection as **inbound + delivered sends + assistant scratch** so scratch is recallable; point keyword recall at it; bound the recent-window to N turns of payload for the prompt while retaining full history for recall (D-MG9, agent-memory keyword recall). [Turn `text` = scratch + sends (FTS already over `text`); window bounded by existing `windowSize`; full history retained for recall.]

## Future phases — split into their own changes

The remaining phases were carved out of this change (they can land in any order):
`security-tools-credentials`, `skills`, `observability`, `subagents`. See
`openspec/changes/<name>/`.
