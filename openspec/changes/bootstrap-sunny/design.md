## Context

Sunny is a self-hosted personal AI agent. Its primary interface is iMessage — an **eternal, asynchronous conversation thread** with no natural session boundaries. This breaks the assumption behind most agent memory designs (including Hermes' CLI model), which freeze a memory snapshot at "session start" and extract memories at "session end." Sunny has neither.

Memory is the part of Sunny that makes it feel like a personal assistant rather than a stateless chatbot with a phone number. Devon's hard requirements: **data ownership/privacy** (this is his whole personal life), **inspectability** (plain files he can read, hand-edit, and `git`), **no vendor lock-in**, and **low/no monthly cost**.

This document now captures the design for **all** of Sunny's capabilities — one section per capability, memory first — plus a project-skeleton section and a post-design Review Resolutions section. The `agent-memory` section directly below is the first.

## Goals / Non-Goals

**Goals:**
- A files-first, human-readable, git-able memory store fully owned by Devon, no third-party data egress.
- An always-on "core" memory that gives Sunny durable context on Devon and itself every message, within a disciplined-but-generous token budget.
- On-demand recall of deeper knowledge and raw history without carrying it all in context.
- Support reasoning about facts that change over time ("worked at Acme in Jan, left in June") without losing history.
- Automatic memory hygiene without requiring Devon to manage it.
- A semantic-recall upgrade path that preserves the single-file, self-hosted, $0 properties.

**Non-Goals:**
- Multi-user / multi-tenant *memory* — Sunny models exactly one owner (Devon). This is about the *memory model*, not the interface: Sunny still operates in multi-participant contexts (group iMessages), where it answers other participants but Devon remains the sole approver of consequential actions (see Review Resolutions R1).
- A managed/cloud memory service.
- A graph database or temporal knowledge graph as part of the initial build.
- Embeddings/vector search in the first version (added only when keyword recall demonstrably fails).

## Decisions

### D1 — Files-first, layered memory (not a managed service, not vector-first)

```
 L0  ALWAYS-ON CORE   (loaded fresh on every message-handling run)
     USER.md   — capped — the model of Devon (identity, prefs, people, comms style)
     SUNNY.md  — capped — the model of itself (operating notes, learned conventions)
     INDEX.md  — capped — one line per topic doc; the "router"
 L1  TOPIC DOCS       (loaded on demand when INDEX says a topic is relevant)
     topics/*.md — unbounded, structured, hand-editable; facts carry [date-range] tags
 L2  RAW RECALL       (searched, never auto-loaded)
     Postgres tsvector/GIN full-text over every message → LLM summarizes hits
 L3  SEMANTIC (later) pgvector in the SAME Postgres DB; local embeddings (Ollama)
```

Rationale: USER.md (facts about Devon) and SUNNY.md (how Sunny should operate) are split because they have different authors (Devon teaches the former; Sunny learns the latter) and decay differently. The INDEX→topic-doc router is adopted from Hermes' in-progress "memory routing" design (issue #22612) so the always-on cost stays bounded while deep knowledge remains reachable.

### D2 — Always-on files are capped; overflow returns an error (forced consolidation)

The memory write tool exposes `add` / `replace` / `remove` and **no `read`** — reading the core is the prompt injection itself, so re-reading is never needed. When a capped file exceeds its limit, the write **fails with an error** rather than truncating, forcing Sunny to consolidate (merge, prune, or promote detail down to a topic doc) in the same turn. Caps are disciplined but more generous than Hermes' ~1,300-token total, given Opus 4.8's context. Exact caps tuned during implementation.

### D3 — "Eternal session" handling: memory is re-read per run; extraction is triggered, not session-bound

Each inbound iMessage triggers a fresh agent run that reads the **current** memory files (so the always-on core is effectively live, re-snapshotted per message). Because there is no session end, memory extraction is driven by:
- **(c) Salience (synchronous):** mid-conversation, Sunny writes a high-salience durable fact immediately (and visibly).
- **(b) Nightly consolidation (self-scheduled cron):** a "memory hygiene" job reads the day's raw messages and updates topic docs / core files. This is Sunny's analog of Honcho's "dreaming," built in-house.

Long threads use a **rolling window** of recent messages verbatim + **FTS recall** for anything older (the iMessage analog of Hermes' `/compress`).

### D4 — Date-tagged facts for temporal reasoning (files-first substitute for a temporal graph)

The one capability plain FTS + markdown cannot natively provide is bi-temporal "what was true when." Rather than adopt a graph DB, **facts in topic docs carry explicit date-range tags**:

```
topics/work.md
• [2025-01 → 2025-06] worked at Acme (left June)
• [2025-06 → present]  founder, Tivona
```

Opus reasons over dated entries to answer point-in-time queries and supersede old facts without deleting history. Captures ~80% of a temporal graph's value at zero infra cost.

### D5 — Semantic upgrade stays in the same Postgres DB

When keyword (tsvector) recall starts missing paraphrases, add **`pgvector`** to the **same** Postgres database that holds the message archive and durable-execution state, with **local** embeddings (Ollama / `nomic-embed-text`). Hybrid keyword+semantic recall, one datastore, still self-hosted, still $0 in egress (embeddings computed locally — no data sent to any third party). No second datastore, no managed memory service.

Note: the DB engine for the L2/L3 tier is Postgres because Sunny adopts Workflow DevKit (`@workflow/world-postgres`) for durable execution (see the Durable Execution section); the message archive, FTS index, vectors, and the workflow journal are consolidated into that one Postgres instance. The memory *soul* (L0 core files + L1 topic docs) remains plain markdown under `~/.sunny/memory/` regardless — the files-vs-DB boundary is unchanged by the engine choice.

### D6 — Co-authored edit rights

Sunny owns the memory files, but they are plain markdown Devon can hand-edit. The `git` history of `~/.sunny/memory/` makes direct edits safe and provides backup + a record of how Sunny's model of Devon evolved.

### Rejected alternatives

- **Managed memory services (Supermemory, Mem0, Honcho, Zep cloud):** built for multi-tenant SaaS; at N=1 their value props collapse to "LLM extracts facts about the user," which the files-first plan already does — while costing data egress, lock-in, and (mostly) a monthly bill. Honcho's "theory-of-mind user modeling" has no payoff for a single user; its only real edge (automatic background profiling) is reproduced by the nightly consolidation cron.
- **Vector-first / embeddings from day one:** keyword full-text search + LLM summarization scales to unlimited single-user history; embeddings are an upgrade added on demonstrated need (D5), not the foundation.
- **Temporal knowledge graph (Zep/Graphiti):** the only genuinely differentiated managed capability, but requires Python + Neo4j/FalkorDB — far too heavy for one user. Approximated by D4; kept in the back pocket only if temporal queries become daily and load-bearing.

## Risks / Trade-offs

- **Always-on budget vs. cost/latency:** every message pays the L0 token cost. Mitigated by caps (D2) and pushing depth to on-demand topic docs (D1). Caps need tuning.
- **Recall quality without embeddings:** keyword FTS can miss paraphrases. Accepted initially; D5 is the escape hatch. The L3 interface is defined up front so it slots in without touching the agent loop.
- **Self-curation drift:** Sunny may write low-quality or contradictory memories. Mitigated by the overflow-forces-consolidation discipline (D2), date-tagged supersession (D4), nightly consolidation (D3), and Devon's ability to hand-edit (D6).
- **Date-tagging is a convention, not enforced structure:** relies on Sunny and Devon maintaining the discipline; weaker than a real bi-temporal store but vastly cheaper.
- **Postgres is now a required daemon:** the stack gains an operational dependency (a Postgres instance) beyond the markdown files. Justified by Workflow DevKit's batteries-included durability and by consolidating messages/FTS/vectors into one store; the memory soul stays in files so backup/inspection of *what Sunny knows* is unaffected.

---

# Messaging Gateway

## Context (messaging-gateway)

Sunny's primary interface is iMessage, with other channels (Telegram, email, CLI, web) added over time. iMessage has no official API; every gateway is an unofficial bridge that requires Apple infrastructure somewhere.

The candidate frameworks are **stacked layers, not rivals**: the Vercel **Chat SDK** (`npm install chat`, ~12 channels, first-class AI SDK integration via `toAiMessages()`) is the channel-abstraction layer; **Sendblue's `chat-adapter-sendblue`** is a published adapter that plugs *into* Chat SDK, providing iMessage (and SMS/RCS) over **Sendblue's hosted API** (no Mac required). Inbound arrives as a signed webhook; outbound is a REST send addressed by phone number or durable group id.

A critical constraint: **the iMessage transport provides no message history** (history and thread-info are unsupported in all three transport modes). The agent must own its own conversation store regardless — which dovetails with the `agent-memory` design, where the Postgres message archive (with tsvector FTS) already is that store.

## Goals / Non-Goals (messaging-gateway)

**Goals:**
- A single normalized interface the agent core speaks; every channel is a pluggable driver behind it.
- iMessage working first, reliably, for 1:1 DMs and group participation.
- Adding a new channel later = adding one adapter, no agent-loop changes.
- Keep the youngest, most vendor-coupled piece (the iMessage transport) swappable.
- Own the conversation store; never depend on the transport for history.

**Non-Goals:**
- Programmatic group creation / cold outreach.

## Decisions (messaging-gateway)

### D-MG1 — Layered stack behind a thin custom `Gateway` seam

```
   Agent core (AI SDK ToolLoopAgent, Opus)
        │   speaks ONLY ▼  (never imports `chat` or the transport adapter)
   ┌────┴───────────────────────────────────┐
   │  Gateway seam  (~custom interface)      │  normalize · route · authorize
   └────┬───────────────────────────────────┘
   ┌────▼───────────────────────────────────┐
   │  Vercel Chat SDK  (npm i chat)          │  channel abstraction, adapters{}
   └────┬───────────────────────────────────┘
   ┌────▼───────────────────────────────────┐
   │  chat-adapter-sendblue                  │  iMessage transport (Sendblue API)
   └─────────────────────────────────────────┘
```

The agent loop depends only on the internal `Gateway` interface, not on Chat SDK or Sendblue types. This is "build on Chat SDK with a (c)-style seam": we get Chat SDK's AI SDK integration and multi-channel `adapters{}` map, but can re-implement the seam on a different transport (another provider, a self-hosted bridge, local macOS DB) without touching the agent.

### D-MG2 — Sunny owns the conversation store

Every inbound and outbound message is persisted to the Postgres message archive (the same store as memory L2). The AI SDK prompt is built from *our* store; `toAiMessages()` is used only as a format helper. Nothing relies on the transport's `thread.allMessages` back-reading iMessage (it can't).

### D-MG3 — Normalized message contract + per-channel capability flags

The gateway normalizes to a channel-agnostic shape and feature-detects capabilities rather than assuming them:

```
 inbound:  ChannelEvent { channel, threadId, senderId, text, attachments[], timestamp }
 outbound: send(threadId, { text, attachments?, typing?, reaction? })
 capabilities: { reactions, readReceipts, typing, groups, proactiveGroup }
```

Sunny queries a channel's `capabilities` and degrades gracefully (e.g., iMessage delivers plain text — no rich Markdown — and has no read receipts). The agent never hard-codes iMessage semantics.

### D-MG4 — Sendblue: DMs and groups both addressable

Sendblue addresses by phone number and exposes **durable `group_id`s**, so Sunny can both reply and **proactively** message Devon — and participate in groups — across restarts. 1:1 DMs and groups are both first-class: inbound arrives via a signed webhook, outbound is a REST send by id. The `proactiveGroup` capability flag is therefore `true` on the Sendblue driver. Group *creation* / cold outreach remains out of scope (D-MG5 non-goals).

### D-MG5 — The transport is the deliberately swappable layer

The iMessage transport is the most vendor-coupled piece, so it sits behind the `Gateway` seam (D-MG1) and is replaceable with no agent-loop changes. If Sendblue's cost, policies, or reliability change, the driver can be re-pointed at another iMessage transport (a self-hosted bridge, local macOS DB, or another provider). Group *creation* and cold outreach remain out of scope regardless of transport.

### D-MG6 — Sender authorization at the gateway

The gateway authorizes inbound senders before the agent acts. For a single user this starts as an allowlist of Devon's identity; the fuller cryptographic DM-pairing model (TTL codes, lockout) belongs to the `security-permissions` capability and will wrap this.

### D-MG7 — iMessage runtime: Sendblue hosted API

The iMessage transport runs on **Sendblue's hosted API**: Sunny runs on Devon's Linux home server and Sendblue handles the Apple-relay infrastructure (no Mac required by Devon, full feature set incl. reactions/typing). The tradeoff accepted is a managed, paid (~$100/mo) dependency in the message path; this is mitigated by D-MG1's `Gateway` seam, which keeps the transport swappable without agent changes.

### D-MG8 — Agent output model: explicit `send_message`, raw model text is private

Sunny does **not** auto-pipe the model's text to the channel. The model's raw output is **private** (reasoning/scratchpad); Sunny talks to the user **only by calling a `send_message` tool**. This decouples *thinking* from *speaking* so Sunny can reason across many steps and tool calls, then emit one (or a few) deliberate, concise messages — the right fit for a low-text-density channel like iMessage. It also matches Anthropic's documented guidance (a `send_to_user`-style tool) and the property that **tool inputs are never summarized**, so the user receives exactly what Sunny wrote. Three complementary layers:

```
 ADAPTIVE THINKING  in-step, private, ephemeral (Anthropic `thinking:{adaptive}`,
                    omitted-by-default on Opus 4.8 — never shown to the user). (D-PS3)
 SCRATCHPAD / NOTES cross-step + cross-session working memory — the agent-memory
                    notes/files surface, distinct from user messages.
 send_message(text) the ONLY path to the user. Verbatim, deliberate, concise.
                    Multiple calls per turn allowed (multi-bubble); sending does NOT
                    end the turn (reason → send → keep working → send again).
```

Specifics:
- **Silence is free:** not calling `send_message` = stay silent (cleaner than Hermes' sentinel token); the system prompt blesses ending a turn without sending when there's nothing useful to say.
- **`send_message` is the natural hook** for typing indicators (fire on turn start / per send), message chunking, and gateway capability-flagging (D-MG3).
- **`send_message` is owner-directed:** in a group, it targets the thread; it carries no special privilege (it's gated like any tool, though it's low-consequence).

**Failure mode + guard (the one real risk):** the agent reasons/works and ends the turn **without ever calling `send_message`**, leaving the owner in silence — Anthropic notes the tool is "rarely called" without explicit instruction. Mitigations: (1) **system-prompt elicitation** ("when you have content the user must read, call `send_message`; use it only for user-facing content, not reasoning/narration"); (2) a **telemetered fallback** — if a turn ends with no `send_message` but produced scratch text, deliver that text so the owner isn't ghosted, and log it loudly (it should trend to zero); (3) **history-as-tool-calls** — Sunny's prior replies are represented in the model's history as `send_message` tool calls (see D-MG9), so its own track record reinforces "speaking == `send_message`". This supersedes the implicit "run to completion → auto-send the final assistant text" in durable-execution D-DE3. *(As-built note: the earlier "inject a nudge / forced re-run" guard was removed in favor of the telemetered fallback + the D-MG9 history representation.)*

### D-MG9 — Turn-grained transcript: one `UIMessage` per row, with retained working context

The conversation store (D-MG2) persists the **AI SDK v6 `UIMessage`** as its unit of record: **one row = one `UIMessage` = one turn** (a sender's complete contribution). This both (a) lets Sunny retain the *working context* it elides from terse iMessage replies, so follow-ups can draw on what it figured out but didn't say, and (b) supersedes the Phase-1 synthetic history reconstruction.

**Why `UIMessage` (not `ModelMessage`).** Per Vercel's persistence guidance, `UIMessage` is the lossless *source of truth*; `ModelMessage[]` is a per-request projection derived via `await convertToModelMessages()` (the inverse is lossy and has **no** SDK helper). Concretely:
- **"1 row = 1 message" maps cleanly only to `UIMessage`.** A turn collapses to one `UIMessage` (text/scratch + tool calls-with-results + `step-start` boundaries as `parts[]`). In `ModelMessage` a single turn *fragments* into interdependent messages (`assistant` + `role:'tool'` + `assistant` …), so "1 row = 1 message" is unachievable without shattering turns.
- **Future-proofs a possible web chat UI.** `useChat` consumes `UIMessage[]` directly (load → render); storing `ModelMessage` would strand us on the lossy/unsupported reverse conversion.
- Tool calls and their results live on a single `ToolUIPart` (state machine), and metadata (`id`, `createdAt`, model, usage) is first-class.

**Storage shape — envelope + payload + projection.** Keep the queryable, transport-agnostic envelope (`channel`, `thread_id`, `message_id`, `role`, `is_owner`, `timestamp`, `processed_at`) for dedup/recovery/window; add a `jsonb` payload holding the `UIMessage` for verbatim replay; keep a flattened `text` column for the `tsvector`/GIN recall (D5/keyword recall). Envelope = queries, payload = replay, text = search.

**Working-context retention.** The assistant turn's plain-text scratchpad (a `text` part on the `UIMessage`) is persisted and replayed, giving cross-turn context without auto-piping it to the user (D-MG8 still holds: `send_message` is the only channel). The model is prompted to write its working context as plain text (private) and to speak via `send_message` — the two-channel contract. **Native Anthropic reasoning is deliberately NOT stored** (keep `thinking.display:'omitted'`): scratch-only keeps the data model simple and avoids reasoning-block *signature* replay.

**Producing `UIMessage`s headless.** No `useChat` exists, so assemble the assistant `UIMessage` via the supported stream path — `agent.stream()` → `readUIMessageStream(result.toUIMessageStream())` — rather than hand-rolling `ModelMessage → UIMessage`. Inbound user `UIMessage`s are constructed trivially (`{ id, role:'user', parts:[{type:'text',…}], metadata }`). `convertToModelMessages()` reconstructs the prompt each turn; the trailing-trim-to-user-message rule still applies.

**Relationship to Chat SDK.** Validated against the Chat SDK: its state adapters are framework bookkeeping (subscriptions/locks/dedup/queues), and conversation history is opt-in and *never auto-owned* (`bot.transcripts`). Keeping our own Postgres transcript is exactly the intended posture; we do **not** adopt `bot.transcripts` (redundant, per-user granularity).

**Open sub-decisions (resolve in implementation):**
- **Full vs filtered fidelity** — store all tool parts (incl. `memory_write`/`schedule_*`/`start_job`) vs sends + scratch only. Lean **full** (truthful, lossless); the prompt carries the scratch-vs-send framing.
- **`generate` → `stream` switch** — required to assemble `UIMessage`s; it interacts with the prompt-cache logging and `prepareStep` steering (both supported on `stream()`) — re-verify.
- **Recall (FTS) source** — delivered sends only (precise) vs sends + scratch (richer, noisier). Lean **delivered-only**.
- **`metadata`** to persist (`createdAt`, model id, token usage).

### Rejected alternatives (messaging-gateway)

- **Auto-pipe model text → channel (with a silence token):** simplest, and what Hermes/OpenClaw do — but it dumps reasoning/narration into a low-density channel and gives the agent no first-class control over each message; relies on the model self-censoring. Rejected for the "think a lot, say a little" goal in favor of D-MG8.

- **Build directly on a raw provider SDK / self-hosted bridge:** loses Chat SDK's `toAiMessages()` / thread-state and AI SDK integration — more hand-rolling for a narrower channel set.
- **Bind the agent directly to one iMessage adapter (no seam):** couples the agent to the youngest, most vendor-coupled layer; a transport outage or pricing change would force agent rewrites.
- **A self-hosted / on-device iMessage bridge as the primary path:** lower running cost, but requires babysitting Mac-relay infrastructure and ships less mature tooling; rejected in favor of Sendblue's managed API + a *published* Chat SDK adapter for reliability. Kept as a fallback behind the seam (D-MG5).

## Risks / Trade-offs (messaging-gateway)

- **iMessage TOS / ban risk:** inherent to all unofficial bridges. A single-user, balanced send/receive, low-volume profile is low-risk; cloud mode shifts relay/ban exposure off Devon's own Apple ID.
- **Vendor/business risk on the transport:** Sendblue is a managed, paid third-party dependency. The `Gateway` seam is the mitigation — the transport is the deliberately swappable piece.
- **Cost:** Sendblue is ~$100/mo — a real ongoing cost, accepted for reliability and durable group messaging; the seam (D-MG5) keeps a cheaper transport swappable if needed.
- **Markdown/format loss + missing features over iMessage:** handled via capability flags and graceful degradation (D-MG3), not assumptions.

---

# Durable Execution

## Context (durable-execution)

Sunny runs on an always-on home server that reboots routinely (updates, crashes, power). Some work is trivial ("what's the weather"); some is long and multi-step ("research X and build a website" — minutes); some is scheduled (nightly memory consolidation). All of it must survive a mid-task restart without losing the user's request or leaving a job half-done and forgotten.

Two facts about the iMessage interface simplify this dramatically:
- **It is async, not request-response.** There is no held-open connection or spinner; the model is "enqueue work, reply whenever." That is natively a durable-job shape.
- **It does not stream tokens.** Messages are delivered complete. So Sunny shows a typing indicator while working and sends a finished message — the entire user-facing streaming/resumable-stream stack (Chat SDK Redis streams, WDK `WorkflowChatTransport`, `useChat`, `getWritable`) is unnecessary.

Research against primary Vercel sources confirmed the AI SDK + Chat SDK + Workflow DevKit compose cleanly and that the earlier "double-write / competing streams" concern was overstated: the official guidance (vercel/workflow Discussion #688) is a single-write-on-completion pattern, and `chat-sdk.dev` does not own message persistence at all.

## Goals / Non-Goals (durable-execution)

**Goals:**
- Survive a reboot mid-turn (re-answer an un-answered message) and mid-job (resume a long task).
- Batteries-included durability (retries, resumption) rather than hand-rolled.
- One datastore: consolidate the message archive, FTS, vectors, and execution state in Postgres.
- Keep trivial conversational turns fast and engine-light.

**Non-Goals:**
- User-facing token streaming and resumable streams (not needed for iMessage).
- Deploying to Vercel's serverless platform (WDK's Postgres world wants a long-lived worker — fine for a home server).
- Multi-day suspended workflows as the primary scheduling mechanism (the `scheduling` capability + cron cover "do X later"; durable suspension is available but not the default).

## Decisions (durable-execution)

### D-DE1 — Two-tier execution

```
 inbound iMessage / cron fire
        │
        ▼
 ┌─ TIER 1 · CONVERSATIONAL TURN (in-process, fast) ──────────────────┐
 │  persist inbound immediately → load memory → agent loop →           │
 │  persist reply on completion → send via gateway.                    │
 │  Durability = idempotent re-processing of un-answered messages,     │
 │  keyed by message id (also gives inbound dedup).                    │
 └─────────────────────────────────────────────────────────────────────┘
        │  agent calls start_job() for long/async work
        ▼
 ┌─ TIER 2 · DURABLE WORKFLOW (WDK) ──────────────────────────────────┐
 │  `DurableAgent` / `'use workflow'`; side-effecting tools = `'use    │
 │  step'` (auto-retry). Survives crash/reboot, resumes, messages the  │
 │  user on completion via the gateway.                                │
 └─────────────────────────────────────────────────────────────────────┘
```

Tier 1 needs no workflow engine — durability comes from persisting the inbound message on arrival and re-processing any message that never produced a reply after a restart. Tier 2 is where Workflow DevKit earns its place: genuinely long or async jobs.

### D-DE2 — Engine: Vercel Workflow DevKit on the Postgres world

Tier 2 runs on WDK with `@workflow/world-postgres` (Postgres state + graphile-worker queue + LISTEN/NOTIFY; no Redis). A long-lived worker process polls the DB — appropriate for an always-on server. The determinism rule is respected by isolating all side effects/nondeterminism inside `'use step'` units.

### D-DE3 — Single-write persistence, no streaming

The agent runs to completion (`agent.generate()` for Tier 1, `DurableAgent` run-to-done for Tier 2). User-facing output is **not** the final assistant text — it is whatever the agent emitted via `send_message` calls during the run (D-MG8); the raw model text is private. No resumable-stream layer is wired up. Each `send_message` delivery and the inbound/outbound message records are persisted to the conversation store (idempotently, so a resumed run doesn't re-deliver a message it already sent — keyed by send id). This keeps the workflow/turn the single source of truth while making the agent's *speaking* an explicit, auditable action rather than a side effect of the final text.

### D-DE4 — One Postgres for everything DB-backed

The message archive (+ tsvector FTS), `pgvector` embeddings (later), and WDK execution/job state live in the same Postgres instance. The memory soul (markdown) stays in files. This is the consolidation the `agent-memory` engine choice (D5) refers to.

### Rejected alternatives (durable-execution)

- **Homegrown SQLite checkpoint runner:** fewer moving parts and no Postgres daemon, but we would own and maintain the durability/resume/retry code. Rejected in favor of WDK's battle-tested durability now that the Vercel stack is confirmed to compose cleanly.
- **Everything through a durable workflow (including trivial turns):** unnecessary Postgres round-trips and latency on "ok thanks"; Tier 1's idempotent re-processing already gives reboot safety for conversational turns.
- **User-facing resumable token streaming:** irrelevant for iMessage's complete-message delivery; would add Redis/`WorkflowChatTransport` complexity for no benefit.
- **Managed/serverless Postgres (e.g. Neon):** rejected for the always-on home-server case. Three concerns: (1) **privacy** — messages, FTS, and embeddings would then live in a third-party cloud, contradicting the self-hosted/no-egress ethos (the whole reason memory's soul stays local). (2) **WDK fit** — the Postgres world runs a long-lived worker using `LISTEN/NOTIFY` + `graphile-worker` polling; serverless Postgres (autosuspend / scale-to-zero, PgBouncer pooling) fits poorly with persistent worker connections and `LISTEN/NOTIFY`. (3) **Latency** — durable execution writes per step, so per-query network round-trips (tens of ms) accumulate vs. local sub-ms. Local Postgres is trivial to run (Docker/apt) on an always-on box, so the lock-in/ops "savings" of a managed service don't apply here. **Use local Postgres.** (Neon stays a fine option if Sunny ever moves to a cloud host where there's no always-on box anyway.)

## Risks / Trade-offs (durable-execution)

- **Postgres + long-lived worker are now required infrastructure.** Accepted; justified by durability + datastore consolidation. (Mirrored in the agent-memory risks.)
- **WDK determinism footgun:** code outside `'use step'` re-runs on resume and must be deterministic. Mitigated by keeping LLM calls and side effects in steps; needs discipline.
- **WDK maturity:** beta-maturing (2026). Mitigated because Tier 1 (the common path) does not depend on it; only long Tier 2 jobs do.
- **"When to promote to Tier 2" is a judgment call:** the agent decides via a `start_job` tool. Mis-promotion (long work on the fast path) risks a turn that doesn't survive a reboot cleanly; guidance lives in the agent's instructions/skills.

---

# Scheduling

## Context (scheduling)

Sunny should be able to act on its own clock — run a task later, on an interval, or on a cron schedule — and to schedule *itself* (e.g. the nightly memory-consolidation job from `agent-memory`, or "remind me tomorrow at 9"). This builds directly on `durable-execution`: a fired schedule is just a Tier-2 durable job.

Grounding fact from the installed Workflow DevKit docs: WDK provides durable **one-shot** delays via `sleep()` (including very long sleeps) and wake-ups, but **no native recurring/cron primitive**. So one-shot delays ride WDK directly; recurring schedules need a small persisted scheduler of our own.

## Goals / Non-Goals (scheduling)

**Goals:**
- Relative one-shot, absolute one-shot, interval, and cron schedules, created from natural language.
- Schedules persist across restarts and fire as durable jobs.
- Sunny can manage its own schedules.
- Safe autonomy: no runaway self-scheduling, and bounded cost for unattended runs.
- Delivery of scheduled output to the user via the gateway.

**Non-Goals:**
- A general distributed job scheduler for many users (single user).
- Sub-minute scheduling precision.
- Long-lived suspended workflows as the recurring mechanism (state is explicit in a table, not an infinite sleep-loop).

## Decisions (scheduling)

### D-SC1 — Schedule types + natural-language interpretation

Supported: **relative one-shot** (`"30m"`, `"2h"`), **absolute one-shot** (ISO timestamp), **interval** (`"every 2h"`), and **cron expression** (`"0 9 * * *"`). The agent translates natural language ("every morning", "in an hour") into one of these canonical forms at creation time. Cron is evaluated in Devon's configured timezone.

### D-SC2 — Persisted in Postgres, dispatched as Tier-2 durable jobs

Schedule definitions live in a Postgres table (the same instance as everything else), so they survive restarts. When a schedule is due, it dispatches a Tier-2 durable workflow (per `durable-execution`). Implementation latitude: one-shot delays MAY be realized directly with WDK durable `sleep()`; recurring schedules use a persisted definition plus a dispatcher (a ~60s ticker that starts due runs and computes the next fire time, or a self-rescheduling workflow). The schedule's *source of truth is the table*, not an in-flight workflow.

### D-SC3 — Self-scheduling tool

Sunny manages schedules through a tool exposing create / list / update / delete, so it can set up, inspect, and tear down its own schedules during normal (interactive) turns.

### D-SC4 — Anti-recursion guard

Schedule-management actions are **disabled inside a scheduled run.** A job executing as a scheduled execution cannot create, modify, or delete schedules — preventing runaway self-scheduling loops. Sunny can still self-schedule from interactive turns; it just can't recursively spawn schedules from within a fired job.

### D-SC5 — Output delivery + run history

A scheduled run delivers its result to a configured messaging target (default: a DM to Devon) via the gateway, with no explicit send needed by the job. Run outcomes/output are retained for inspection (ties to `observability`).

### D-SC6 — Cost/rate cap on autonomous runs

Because scheduled runs execute unattended on Opus, each run is subject to a configurable cost/token cap and the scheduler to a rate limit. Exceeding the cap stops the run and notifies Devon rather than silently spending. (Enforcement detail lives in `observability`/budget metering.)

### Rejected alternatives (scheduling)

- **Infinite self-rescheduling workflow as the only mechanism:** opaque (schedule state hidden in an in-flight run), and exposes WDK's determinism footgun on an unbounded loop. Keep schedule state explicit in a table; a workflow may *implement* a recurrence but isn't the system of record.
- **Letting scheduled runs create schedules (no guard):** invites runaway self-scheduling and cost blowups — explicitly forbidden by D-SC4.
- **A separate scheduler datastore (e.g. the old `cron/jobs.json`):** rejected in favor of the consolidated Postgres instance.

## Risks / Trade-offs (scheduling)

- **Unattended cost:** autonomous runs spend money without a human in the loop. Mitigated by D-SC6 (per-run cap + rate limit) and D-SC4 (no recursion).
- **Missed fires while the host is down:** on restart, due one-shots SHALL run once (catch-up); intervals/cron SHALL resume forward without backfilling every missed occurrence (no thundering herd). This is a policy choice favoring "fire once, move on" over strict backfill.
- **Clock/timezone correctness:** cron is evaluated in Devon's timezone; DST edges are a known sharp corner.

---

# Security & Permissions

## Context (security-permissions)

Sunny has shell access to the home server, a browser that drives Devon's logged-in sessions, the ability to read/send email, install and run skills, and self-scheduling — while constantly reading **untrusted content** (web pages, emails, installed skills, file contents) that can carry injected instructions. Prompt injection is not reliably solvable.

## Goals / Non-Goals (security-permissions)

**Goals:**
- Contain the blast radius of a hijacked model: high-consequence actions cannot happen without a hard rule or Devon's approval stopping them.
- Make approvals a natural part of the iMessage UX.
- Keep secrets out of the model entirely (detailed in `credentials`).

**Non-Goals:**
- Preventing the model from being manipulated by injected content (assumed impossible; we gate consequences instead).
- Full host sandboxing of every tool (Devon chose direct host access; only the credentialed browser is isolated).

## Decisions (security-permissions)

### D-SEC1 — Core principle: assume model compromise, gate consequences

The security model assumes any untrusted content may hijack Sunny's reasoning, and ensures a hijacked Sunny still cannot take irreversible or credential-leaking action without a hard rule or human approval intervening. Every other decision derives from this.

### D-SEC2 — Identity: only the paired user commands Sunny

Inbound commands are authorized at the gateway (extends `messaging-gateway` D-MG6): cryptographic DM-pairing establishes that a sender is Devon. Only the paired identity can issue commands or grant approvals.

### D-SEC3 — Approval tiers: balanced "smart" mode, with hard-gated categories

Actions are classified into three gates:

```
  AUTO (no prompt)        APPROVAL (text Devon first)        FORBIDDEN (hard block)
  web search/fetch        send email                          rm -rf /, fork bombs,
  read-only shell         credentialed web actions            disk wipes
  read non-secret files   spend money / purchase              read the op token file
  build a site (devbox)   destructive/writing shell           disable own guardrails
  draft (not send)        public deploy                       exfiltrate whole vault
  query memory            install a skill                     raw secret → unapproved dest
```

A "smart" risk-assessor (an auxiliary LLM judgment) may auto-approve likely-safe actions to reduce friction, **but the APPROVAL categories above are hard-gated regardless of what smart-mode concludes** — money, destructive/irreversible, and "acting as Devon" (send email, credentialed web) always prompt. Approvals are delivered over iMessage (AI SDK v6 `needsApproval`); only the paired identity (D-SEC2) can approve; approvals default-deny on timeout.

### D-SEC4 — Hard blocklist

A fixed blocklist of catastrophic actions is always refused regardless of approval mode or even an explicit approval (e.g. wiping disks, fork bombs, reading the 1Password token file, weakening Sunny's own security configuration). This is the floor beneath the approval tiers.

### D-SEC5 — Surface isolation: credentialed browser isolated; host otherwise direct

Per Devon's choice, host access is direct except the **credentialed browser**, which runs in an **isolated browser profile/process** so a prompt-injected page cannot reach the broader host or other sessions. **Installed skills run directly** (not sandboxed) — accepted because skill **installation** is an APPROVAL-gated action (D-SEC3) and Sunny prefers self-authored skills and review-before-enable for anything from `skills.sh`.

### D-SEC6 — Prompt-injection containment

Untrusted content (web pages, email bodies, skill files, context files) is treated as **data, not instructions**. Content is clearly delimited as untrusted in prompts; Sunny does not follow instructions embedded in fetched/read content; high-consequence actions triggered while processing untrusted content still hit D-SEC3/D-SEC4. (Containment, not prevention — the gates are the real defense.)

### D-SEC7 — Audit logging

Every tool invocation and every secret access is logged (with secrets redacted) to the `observability` layer, so Devon can review what Sunny did and touched. Native 1Password access auditing requires a Business plan; Sunny's own audit log does not depend on it.

### Rejected alternatives (security-permissions)

- **Rely on detecting/preventing prompt injection:** not reliably possible; would create false confidence. Replaced by consequence-gating (D-SEC1).
- **Sandbox everything (sandbox-first):** rejected by Devon in favor of direct access + approval tiers; only the credentialed browser is isolated (D-SEC5).
- **Minimal approval (autonomy-first):** too risky for a credentialed agent; "acting as Devon" and money/destructive stay gated.

## Risks / Trade-offs (security-permissions)

- **Smart-mode can be fooled:** mitigated by hard-gating the high-consequence categories regardless of its verdict (D-SEC3).
- **Installed skills run with full host access (D-SEC5):** residual risk accepted; mitigated by gating installs and preferring self-authored/reviewed skills. Revisit if skill installs from registries become common.
- **Approval fatigue:** too many prompts erode attention. Smart-mode and a conservative-then-relax posture mitigate; tune over time.
- **Injection is contained, not prevented:** a hijacked Sunny can still do anything in the AUTO tier. Kept low-consequence by construction.

---

# Credentials

## Context (credentials)

Devon stores secrets in 1Password and wants to use 1Password's own tooling rather than a custom vault. Sunny (TypeScript, headless Linux) needs to read API keys at runtime and, later, authenticate a browser session — without exposing secrets to the LLM or to plaintext config.

Key 1Password facts (from research): the official **TS SDK** (`@1password/sdk`) authenticates with a **Service Account** token and resolves `op://` references to values in-process; **Service Accounts cannot access the user's Private vault or the default Shared vault** (so a dedicated vault is required *and* this restriction is a safety feature); there is **no sub-vault/per-item scoping** (the vault is the blast-radius boundary); the token **is a master key** to its scoped vault(s).

## Goals / Non-Goals (credentials)

**Goals:**
- The LLM never receives secret values.
- "Sunny can't read my real creds" is literally true for everything outside a dedicated minimal vault.
- Low-friction curation of what Sunny can access (drag/copy items in the 1Password UI).

**Non-Goals:**
- Per-item access control inside a vault (doesn't exist in 1Password; use the vault boundary).
- Hiding values from Sunny's *process* (impossible — the process must read values to use them; the protection is scoping + not exposing to the model).

## Decisions (credentials)

### D-CR1 — Dedicated minimal `Sunny` vault + read-only Service Account

A new dedicated `Sunny` vault holds only what Sunny needs. A read-only Service Account (`read_items`) scoped to just that vault provides access via `OP_SERVICE_ACCOUNT_TOKEN`. Everything outside the Sunny vault is unreadable by construction (reinforced by 1Password forbidding Service-Account access to the Private vault). Devon populates the vault by copying items via the 1Password UI (Copy, not Move, for creds he also uses).

### D-CR2 — The model sees references, never values

Sunny's reasoning model only ever handles `op://vault/item/field` references (or symbolic names), never resolved values. Values are resolved by `@1password/sdk` in the **tool-execution layer** at the moment of use and injected into the HTTP client / browser fill / subprocess env — never placed in prompts, tool arguments, responses, or logs.

### D-CR3 — Per-tool reference whitelist

Because there is no per-item scoping in 1Password and the model could be hijacked, **each tool declares the exact `op://` references it may resolve.** The model cannot cause resolution of an arbitrary `op://` path. This is the most important guardrail (it substitutes for the missing per-item scoping) and links to `tool-access`.

### D-CR4 — Token hardening + rotation

The Service Account token lives in a root-owned `0600` file (e.g. systemd `EnvironmentFile`), never in the repo, never dumped to logs/context, and is on the hard blocklist (D-SEC4). It is rotated on a schedule (1Password has no auto-expiry), reusing `scheduling`.

### Rejected alternatives (credentials)

- **Point a token at Devon's existing/personal vault:** impossible (1Password blocks Service Accounts from the Private vault) and would defeat "Sunny can't read my creds." Use a dedicated vault.
- **Custom-built secrets vault:** unnecessary given 1Password's SDK + Service Accounts; reuse the user's existing trusted store.
- **1Password Connect / Business audit / capability-segmented multi-vault:** deferred. Connect only if rate limits bite; Business only if native audit is needed; multi-vault segmentation revisited when the credentialed-browser/email paths grow (start with one dedicated vault for simplicity).
- **Desktop-app MCP server / SSH agent:** require an interactive desktop session; unusable on a headless server.

## Risks / Trade-offs (credentials)

- **The token is a master key to the Sunny vault:** anything that reads the token, or tricks a tool into resolving an arbitrary reference, can read every item in that vault. Mitigated by: minimal vault contents, read-only, per-tool reference whitelist (D-CR3), token hardening (D-CR4), and the AUTO/APPROVAL gates.
- **Single vault = coarser blast radius than capability-segmented vaults:** accepted for simplicity now; the vault is kept minimal and segmentation is a documented future step.
- **Copy (not live-link) duplicates:** rotated creds must be updated in both places; noted as a curation chore.
- **No native audit without Business:** mitigated by Sunny's own audit log (D-SEC7).

---

# Tool Access

## Context (tool-access)

Sunny's value is in its tools: shell on the host, a web-research fetcher, a credentialed browser, email, todos, and building/hosting websites (via the `devbox` skill). Each tool has a different risk profile and different credential needs; the security and credentials policies must attach to tools uniformly.

## Goals / Non-Goals (tool-access)

**Goals:**
- A uniform way to register tools that carries risk tier + credential references.
- Every tool's gating derives from its declared risk tier via the security policy.
- The credentialed browser tool routes through the isolated profile (D-SEC5) and resolves logins via reference whitelist (D-CR3).

**Non-Goals:**
- Enumerating the final, complete tool set now (it grows); this defines the *contract* every tool follows.

## Decisions (tool-access)

### D-TA1 — Bash-centric capability; permissioning at the command/skill layer (revised per review)

*(This supersedes an earlier framing that proposed a dedicated gated tool per permissioned activity — see Review Resolutions R13. Devon's point: in a CLI-centric world bash is the universal tool, and per-activity tools are brittle. Researched prior art — Claude Code's permission rules + hooks, `allowed-tools`, Hermes/OpenClaw/Goose/OpenHands — strongly supports gating at the **command** level.)*

Capability is exposed primarily through a **`bash` tool** (most third-party capabilities are CLIs) plus a few genuinely non-CLI tools (the credentialed browser driver, memory ops). Permissioning therefore attaches to **commands and skills**, not to a proliferation of per-activity tools. The layered model:

```
 (a) Command-approval policy  deny-by-default allow/ask/deny rules, matched on a
                              PARSED command (AST), enumerating every sub-command
                              across pipes/$()/chains, FAIL-CLOSED on substitution/
                              complexity (uncertain → ask). Patterns route; they are
                              NOT a security boundary (Claude Code says so explicitly).
 (b) Skill-scoped allowlists  an active skill pre-approves only the commands it needs
                              (`allowed-tools`-style); grants within the deny baseline.
                              → this is "permissioning in the skills layer."
 (c) Smart-mode triage        a cheap model (Haiku) triages only the uncertain "ask"
                              middle (D-SEC3 / R10) — never the sole gate.
 (d) Hard blocklist           non-overridable, trips first (D-SEC4).
 (e) Containment boundary     the REAL security layer: sandbox (bubblewrap/Landlock/
                              seccomp) + egress control. "Contain at the environment
                              layer first, steer at the model layer second."
 (f) Per-command credentials  `op run`: the model emits `op://` refs; they resolve into
                              ONLY that subprocess's env at exec time (masked in output),
                              never the model context (refines D-CR2/D-CR3).
```

### D-TA2 — Tools, skills, and where permissioning lives

```
  TOOLS (thin)              Notes
  ─────────────────────────────────────────────────────────────
  bash                      the universal capability surface; gated per-command (D-TA1)
  credentialed browser      genuine non-CLI tool (Playwright); isolated profile (D-SEC5)
  memory read/write         core-memory mutation (serialized, R7)

  CAPABILITIES AS SKILLS    (compose bash + the tools above)
  ─────────────────────────────────────────────────────────────
  build / run / host sites  → the `devbox` skill (over bash); public deploy is an
                              ask/blocked command in the policy
  email read / triage       → a skill over bash + the himalaya CLI (R5); the himalaya
                              *send* subcommand is hard-gated by the command policy
  research, todos, etc.     → skills composing bash / web fetch
```

Permissioning is uniform: every command — whether typed directly or run by a skill — passes the command-approval policy (a) + blocklist (d), within the skill's declared scope (b), with the uncertain middle triaged by smart-mode (c), contained by the sandbox/egress boundary (e), and credentials injected per-command (f). "Acting as the owner" commands (himalaya send, credentialed browser actions, publish/deploy) are hard-gated regardless of smart-mode.

**Containment via taint-tracking + step-up auth, not blanket sandboxing (resolved with Devon, R14).** Blanket-sandboxing bash is self-defeating — Sunny needs real host access to do devops on its own server. The risk isn't "untrusted commands" in the abstract; it's a command whose *construction was influenced by untrusted content* (a prompt injection from a web page / email / installed-skill output). So we **track provenance** and gate on it:

- **Clean commands** — derived from Devon's direct instruction with no untrusted content in the run's context — run under the normal command policy (allow/ask/deny) with **full host access**. This is the devops path; sandboxing would break it, so we don't.
- **Tainted commands** — produced while untrusted content is in context — require **step-up ("2FA") approval**: a distinct, high-friction confirmation that shows the exact command *and flags its untrusted provenance*, ideally backed by a real second factor (TOTP / passkey / out-of-band tap) so it can't be quietly rubber-stamped. Credentialed/destructive tainted commands get the strongest confirmation or are refused.
- **Unattended (scheduled/autonomous) runs** can't step-up an absent human, so a tainted command there is **blocked and deferred to Devon**, or run in a *targeted* sandbox for that case only. (Sandboxing isn't gone — it's the fallback when no human is present, not the everyday boundary.)
- **Egress/network control stays a cheap backstop** regardless — it limits where data can flow even if a tainted command runs, and it isn't intrusive to devops (it's network policy, not command sandboxing).

This honors "direct host access" for the common path while putting the strongest gate exactly where the injection risk concentrates.

### D-TA3 — Credentialed browser specifics

The browser tool runs in the isolated profile (D-SEC5), fills credentials resolved from its whitelisted references at fill-time inside the automation layer (never echoed to the model, D-CR2), and any credentialed *action* is approval-gated. 1Password's enterprise "Secure Agentic Autofill" is not used (early-access/enterprise); this is the DIY equivalent.

### Rejected alternatives (tool-access)

- **Ad-hoc per-tool security handling:** rejected; gating and credential rules must be uniform and declarative so a new tool can't accidentally bypass them.
- **Giving tools broad credential access:** rejected; default is no credential references, opt-in per reference (D-TA1/D-CR3).

## Risks / Trade-offs (tool-access)

- **Tool authors could under-declare risk:** a tool mis-tiered as `auto` could bypass approval. Mitigated by conservative defaults (unknown/destructive → approval) and review of new tools.
- **Reading email/web is `auto` but feeds untrusted content into the model (D-SEC6):** the consequence-gating (D-SEC3/4) is what keeps this safe, not the read itself.
- **Catalog will grow:** the contract (D-TA1) is the durable part; specific tools are added over time.

---

# Agent Skills

## Context (agent-skills)

A central part of Sunny's vision is that it can **install, write, and learn its own skills** — modular, file-based units of procedure that teach it how to do things. Research established that the `agentskills.io` `SKILL.md` format is a real, multi-vendor open standard (Claude Code, Cursor, Hermes, OpenClaw, the Vercel skills already in this repo), with progressive disclosure for context efficiency and shipping prior art for runtime self-authoring (Anthropic's skill-creator).

**Install sources — `skills.sh` is a discovery index, not the substrate.** Because the format is just a `SKILL.md` in a Git repo and `npx skills add owner/repo` installs from *any* Git source (GitHub/GitLab shorthand, full URLs, per-skill paths, local dirs), the real "registry" is **Git + the format**. `skills.sh` is a zero-curation popularity index over those same repos — useful for discovery, not a separate integration. Other notable sources: Anthropic's curated **`anthropics/skills`** and **`vercel-labs/agent-skills`** repos; per-agent registries like OpenClaw's **ClawHub** and Hermes' **Skills Hub** (both convenience indexes over the same git+format substrate); and "awesome-skills" community lists. Sibling projects worth tracking: **OpenClaw** (`openclaw/openclaw`) is a local-first personal AI assistant — also multi-channel incl. iMessage, also `SKILL.md`-based — i.e. the closest existing thing to Sunny; and **Hermes** uses `SKILL.md` under `~/.hermes/skills/`. So skills are broadly portable, with caveats (tool-name assumptions, `allowed-tools` is experimental, OS/`metadata` gating is agent-specific).

Because any of these resolve to untrusted third-party code, installed skills must be treated as untrusted (D-SK5).

## Goals / Non-Goals (agent-skills)

**Goals:**
- Standard, portable, self-authorable skills (`SKILL.md`), stored as git-able files.
- Context-efficient discovery that scales as the library grows.
- Sunny authoring its own skills with low friction (auto + notify), and installing external skills safely (gated, reviewed).
- Skills that cannot escalate privilege — their actions are gated like any tool use.

**Non-Goals:**
- A bespoke skill format (adopt the open standard).
- Sandboxing skill execution (per security D-SEC5, skills run direct; installation is the gated event).
- A full automated skill-eval/benchmark loop now (a possible later enhancement).

## Decisions (agent-skills)

### D-SK1 — Adopt the `SKILL.md` open standard, files-first

Skills follow `agentskills.io`: a `skills/<name>/SKILL.md` (YAML frontmatter — `name`, `description` required; optional `license`, `compatibility`, `metadata.version`, `allowed-tools`) plus optional `scripts/`, `references/`, `assets/`. Stored under `~/.sunny/skills/`, git-able like the memory soul. This makes skills portable across agents and installable from `skills.sh`.

### D-SK2 — Progressive-disclosure loading, on a shared always-on budget

Only skill `name` + `description` are always in context (an index); the body loads when a task matches; `references/`/`scripts/` load/execute on demand (script code never enters context — only its output). The metadata index is budget-capped (drop least-used descriptions first, names retained) and shares the always-on token budget defined in `agent-memory`.

### D-SK3 — Discovery scales via pgvector retrieval

When the library outgrows the metadata budget, candidate skills are pre-selected by embedding their descriptions and retrieving the nearest matches — reusing the same local-embeddings + `pgvector` infrastructure introduced for memory L3. No new datastore.

### D-SK4 — Self-authoring loop (auto + notify)

A `skill_manage` tool lets Sunny create / edit / delete its own skills. The loop: reflect on a completed task → write a `SKILL.md` with a deliberately pushy, keyword-rich description → validate → save → auto-discovered next run. Triggers (from Hermes/skill-creator): completing a gnarly multi-step task, recovering from an error/dead-end, a user correction, or discovering a reusable workflow. The memory-vs-skill boundary (`agent-memory`): durable *fact* → memory, durable *procedure* → skill.

Self-authored skills are created **automatically and the user is notified** (e.g. "wrote a skill: deploy-tivona-site"); they are immediately usable. The user can review/edit/delete the file at any time (git history makes this safe). This mirrors the co-authored memory posture (D6).

### D-SK5 — Two trust tiers: self-authored (trusted) vs installed (untrusted)

- **Self-authored** skills are trusted (Sunny wrote them under its own guardrails) → auto + notify (D-SK4).
- **Installed** skills (from **any agentskills-compatible Git source** via `npx skills add owner/repo` — which covers the skills.sh index, `anthropics/skills`, `vercel-labs/agent-skills`, and arbitrary repos) are **untrusted code** → installation is an APPROVAL-gated action (security D-SEC3/D-SEC5), validated (D-SK7) and reviewed before enable. They run directly (not sandboxed), so the protection is install-time gating + review + execution-time gating (D-SK6). We don't integrate any proprietary registry protocol — "install from any Git source containing a `SKILL.md`" is the single primitive; ship `anthropics/skills` + `vercel-labs/agent-skills` (and your own `devbox`) as seeded known-good defaults.

### D-SK6 — Skills cannot escalate privilege

A skill body is instructions; when it runs scripts or invokes tools, those pass through normal tool-access gating (D-TA1), the approval tiers (D-SEC3), and the hard blocklist (D-SEC4). A skill's optional `allowed-tools` frontmatter may *further restrict* (never expand) what it can use. So even a malicious installed skill cannot bypass the consequence-gating floor.

### D-SK7 — Validation before activation

Skills are validated against the `SKILL.md` schema (e.g. the agentskills reference validator) on creation/installation; an invalid skill is not activated.

### Rejected alternatives (agent-skills)

- **Bespoke/proprietary skill format:** loses portability and the `skills.sh` ecosystem; rejected for the open standard.
- **Trust installed skills like self-authored ones:** ignores that `skills.sh` is zero-curation with bypassable scanning; rejected — installs are gated and reviewed.
- **Review-gate self-authored skills:** rejected per Devon's choice (auto + notify) for low friction; the file is reviewable/reversible anyway.
- **Embedding-retrieval from day one:** unnecessary at small library sizes; the metadata index suffices until it doesn't (D-SK3).

## Risks / Trade-offs (agent-skills)

- **Installed skills run with full host access (untrusted code):** mitigated by approval-gated installs, review-before-enable, `allowed-tools` restriction, and execution-time gating (D-SK6). Sandboxing remains a future option if registry installs become common.
- **Self-authored skill sprawl / low quality:** auto-creation may accumulate weak skills. Mitigated by notification + reviewability, least-used eviction from the index (D-SK2), and (later) an eval loop.
- **Always-on budget pressure:** many skills compete with memory for always-on context. Mitigated by budget caps and pgvector retrieval (D-SK2/3).
- **Description quality drives discovery:** under-triggering if descriptions are weak; mitigated by the "pushy, keyword-rich description" authoring heuristic (D-SK4).

---

# Observability

## Context (observability)

Sunny acts autonomously (self-scheduling, long jobs, credentialed actions) and spends real money on Opus. Devon needs to see what it did, bound its cost, and review what it touched. Several finalized capabilities already point here: the security audit log (D-SEC7), scheduling's per-run cost cap and autonomous rate limit (D-SC6), and the always-on token budget (`agent-memory`). This capability consolidates them.

## Goals / Non-Goals (observability)

**Goals:**
- Standard, inspectable tracing of every turn/job/tool/LLM call.
- A cost/token meter that can *enforce* caps, not just report.
- A redacted audit trail of actions and secret access.
- A human-readable insights summary on demand.
- Self-hosted, no personal data egress.

**Non-Goals:**
- Shipping telemetry to a third-party cloud APM by default.
- A bespoke tracing format (use OpenTelemetry).

## Decisions (observability)

### D-OB1 — OpenTelemetry as the tracing standard, self-hosted

Tracing uses **OpenTelemetry**: AI SDK telemetry emits spans for LLM/tool/step calls; Workflow DevKit contributes execution spans; the gateway and tool layer add their own spans. Spans export to a **self-hosted local OTel collector/backend** — no egress. A cloud APM is opt-in only.

### D-OB2 — Persistent per-run trajectories

Each turn and job records a structured trajectory (messages, tool calls + results, decisions) persisted in Postgres, for inspection, debugging, and a future skill-eval loop. Complements OTel spans (spans for live tracing; trajectories for durable replay/analysis).

### D-OB3 — Cost/token budget meter with enforcement

Token usage and cost are metered per run and over rolling windows (e.g. per day). The meter is the **enforcement point** for the caps declared elsewhere: scheduling's per-run cost cap and autonomous rate limit (D-SC6) and the always-on budget pressure (`agent-memory`). A run that exceeds its cap is stopped and Devon is notified rather than continuing to spend.

### D-OB4 — Redacted audit log

Every tool invocation and secret access is written to a queryable audit log (fulfilling security D-SEC7), with all secret values redacted (ties to credentials D-CR2/D-CR4). The audit log does not depend on a 1Password Business plan.

### D-OB5 — Redaction across all sinks

A redaction layer ensures secrets and the Service Account token never appear in traces, logs, trajectories, or insights. This is a hard property of every telemetry sink, not a per-call concern.

### D-OB6 — User-facing insights

Sunny can produce an insights summary (token usage, cost, tool breakdown, activity) deliverable over the messaging gateway on request or on a schedule.

### Rejected alternatives (observability)

- **Default cloud APM (Datadog/Honeycomb/etc.):** egresses personal activity data; rejected as default, allowed only as explicit opt-in.
- **Bespoke trace format:** rejected for OpenTelemetry's portability and tooling.
- **Report-only cost tracking:** insufficient — the caps must be enforceable (D-OB3), or autonomous runs could overspend.

## Risks / Trade-offs (observability)

- **Self-hosted telemetry is ops to run:** a local collector/backend to maintain; accepted for privacy. Kept minimal.
- **Trajectory storage growth:** Postgres trajectories accumulate; needs retention/pruning policy.
- **Enforcement vs. interruption:** hard cost cutoffs can abort useful work mid-run; mitigated by notifying Devon and tuning caps.

---

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

# Project Skeleton & Conventions

## Context (project-skeleton)

Foundational, non-capability decisions that make the eight capabilities implementable: runtime, repo layout, the `~/.sunny/` contract, model wiring, config/secrets, and home-server deployment. Grounded in the installed AI SDK / Workflow / Chat SDK skills and the `claude-api` reference.

## Decisions (project-skeleton)

### D-PS1 — Runtime: Node LTS + TypeScript (not Bun)

The Vercel stack is Node-first: Workflow DevKit's Postgres world uses `graphile-worker` (Node), `@1password/sdk` needs Node 18+, and the AI/Chat SDKs target Node. Use **Node LTS + TypeScript**; reject Bun for compatibility/maturity now (revisit later). Postgres access via **Drizzle** (the Vercel-ecosystem ORM; Chat SDK uses it) with Drizzle migrations.

### D-PS2 — Repo layout

```
sunny/
  src/
    agent/          loop wiring (ToolLoopAgent / DurableAgent), model config
    gateway/        normalized Gateway seam + channel drivers (iMessage first)
    memory/         core files, recall, consolidation
    skills/         loader, skill_manage, validation
    tools/          tool registry (risk tier + cred refs) + tool impls
    security/       approval tiers, blocklist, gating
    credentials/    1Password SDK wrapper + reference whitelist
    scheduler/      schedules + dispatch
    durable/        WDK workflows + world config
    observability/  OTel, trajectories, budget meter, audit
    db/             Drizzle schema + migrations
    config/
  .agents/skills/   installed reference skills (ai-sdk, chat-sdk, workflow)
  openspec/
~/.sunny/           runtime state (separate from the repo)
  memory/  (USER.md, SUNNY.md, INDEX.md, topics/)   git-able
  skills/  (self-authored + installed SKILL.md dirs) git-able
  + Postgres (separate daemon: messages/FTS/vectors/workflow/trajectories)
```

The repo is code; `~/.sunny/` is runtime state. **`~/.sunny/` is a single git repo** (covering `memory/` and `skills/` together) for backup and history — not nested per-subdirectory repos. It is separate from the code repo by *location* (`~/.sunny/` vs the project dir), not nested inside it, so there are no submodules or nested-repo headaches.

### D-PS3 — Model wiring

AI SDK v6 with `@ai-sdk/anthropic`; model `anthropic('claude-opus-4-8')` (exact id; 1M context, 128K output). Default to **adaptive thinking** (`providerOptions.anthropic.thinking = {type:'adaptive'}`) and **effort** `high`/`xhigh` for agentic turns (`output_config.effort`). Provider-agnostic by design — swapping models is a one-line change — but Opus 4.8 is the default. `ANTHROPIC_API_KEY` from env.

### D-PS4 — Prompt-cache the always-on core (cost control for the always-on budget)

The always-on memory core + skill metadata + tool definitions form a **stable system prefix** sent on every message. Mark it cacheable (Anthropic prompt caching via `providerOptions.anthropic` cache control); cached reads bill at ~0.1× and the minimum cacheable prefix on Opus 4.8 is ~4096 tokens. This largely neutralizes the `agent-memory` "always-on budget vs cost" risk. **Hard constraint:** keep the prefix byte-stable — no timestamps/UUIDs/per-request data in the system prompt, deterministic tool ordering. Per-run dynamic context (approval mode, current time, remaining budget) is injected as **mid-conversation system messages** or user-turn context, never by editing the cached prefix.

### D-PS5 — Config & secrets

Non-secret settings live in a config file under `~/.sunny/` (approval mode, cost/rate caps, the `Sunny` vault name, channel config, timezone, model id, always-on caps). Secrets are env-only — `ANTHROPIC_API_KEY` and `OP_SERVICE_ACCOUNT_TOKEN` — loaded from a hardened systemd `EnvironmentFile` (root-owned `0600`), never in the repo or logs (ties to credentials D-CR4).

### D-PS6 — Deployment on the Linux home server

A single long-lived `sunny` systemd service hosts: the HTTP webhook listener for Sendblue inbound, the WDK Postgres-world worker, and the scheduler tick — plus a Postgres service. `Restart=always` (durability depends on restart survival, per `durable-execution` D-DE1). Not serverless (WDK's Postgres world wants a long-lived process — appropriate here).

## Risks / Trade-offs (project-skeleton)

- **Cache invalidation foot-gun:** any accidental per-request byte in the system prefix silently kills the cache (cost spikes). Mitigated by D-PS4's stability rule and verifying `cache_read_input_tokens > 0`.
- **Single-process service:** gateway + worker + scheduler in one service is simple but couples failure domains; split later if needed.
- **Node-not-Bun:** accepts slower cold start for ecosystem compatibility.

---

# Review Resolutions (post-design audit)

A critical review surfaced conflicts, gaps, and one overstated claim. Resolutions:

### R1 — Group trust model: owner-commands, others-context (resolves the D-SEC2 ↔ D-MG4 conflict)

In a group chat, Sunny treats **everyone's** messages as context and may **answer questions**, but only **Devon** (the paired identity) can trigger high-consequence / credentialed / spending actions, and only Devon can grant approvals. Non-owner participants get a read-and-answer assistant, not an actor. This supersedes the absolute reading of D-SEC2 ("only Devon commands") for groups: *answering* is open within an authorized group; *acting with consequence* and *approving* remain owner-only. The gateway tags each inbound message with `isOwner`; the security layer keys action-gating and approval-authority on `isOwner`.

### R2 — Prompt caching is conditional, not a blanket win (corrects D-PS4 / agent-memory cost risk)

Anthropic's cache TTL is 5 min (1 hr option), but Sunny's primary path is sporadic messages hours apart. A cache **write** costs ~1.25×, so caching a one-step turn whose cache expires before the next message costs **more** than not caching. Therefore: enable prompt caching **only when a read is likely within TTL** — i.e. within a single multi-step agent turn (the tool loop re-sends the growing prefix) and during rapid message bursts; use the 1 hr TTL where it helps. Do **not** treat the always-on core as "free." The `agent-memory` "always-on budget vs cost" risk stands and the caps are load-bearing. D-PS4 is a conditional optimization, not a cost eliminator.

### R3 — Website building/hosting = the `devbox` skill; durable public deploy deferred (resolves the missing-capability gap)

Sunny builds and runs sites via the **`devbox` skill** (preview / temporary public share URLs for review), not durable public hosting under Devon's domain. Durable public deploy stays **approval-gated** (D-SEC3) and is deferred past v1 — keeping the "prompt-injected agent publishes under your identity" surface small.

### R4 — Skill installation is concretely `npx skills` (sharpens D-SK5)

Sunny installs published skills with Vercel's **`npx skills add owner/repo`** (the same tool used to install `devbox`, `ai-sdk`, etc.). This is the untrusted-code path: still **approval-gated** and review-before-enable (D-SK5). Self-authored skills remain auto+notify (D-SK4).

### R5 — Email: Sunny's own mailbox + CC-to-act, via a CLI (resolves the channel-vs-tool ambiguity)

Sunny has its own address **`sunny@waywardlane.com`**, accessed through the **himalaya** CLI (IMAP/SMTP, JSON output). Devon **CCs or forwards** mail to direct action — so Sunny only ever processes mail deliberately sent to it, not Devon's whole inbox. This is the *trust filter*: directedness = intent. It behaves as a lightweight inbound channel (poll/IDLE on `sunny@`), but **sending stays approval-gated** (acting as Sunny), and message bodies are still untrusted content — processed under injection containment (D-SEC6), ideally via a no-credential subagent (D-SUB5). Replaces the earlier "email as future channel / email tools" ambiguity.

### R6 — Credentialed browser: persistent logged-in profile (decides D-TA3 / D-SEC5 open point)

The isolated browser keeps a **persistent logged-in profile** (stored session cookies) so 2FA is handled once. Consequence: **the cookie store is a credential surface and is protected like the 1Password token** — on the hard blocklist (D-SEC4), never read by other tools, excluded from logs/context. Stack assumed Playwright; profile isolation per D-SEC5.

### R7 — Concurrency & memory-write serialization (resolves the multi-writer markdown hazard)

Conversational turns are **serialized per thread** (rapid inbound messages on one thread queue rather than race). **All memory-file mutations** (conversational turns, Tier-2 jobs, the nightly consolidation) go through a **single serialized writer / advisory lock** so `USER.md`/`SUNNY.md`/`topics/*.md` can't be corrupted by concurrent writes. Reads are snapshot-at-run-start (per agent-memory D3).

### R8 — Global spend circuit-breaker (closes the budget gap)

Beyond per-run caps (D-SC6) and metering (D-OB3), there is a **global daily/monthly spend ceiling and kill switch** covering *all* activity (interactive and scheduled). Exceeding it halts new agent work and notifies Devon. Also cap the agent loop's max steps (WDK `DurableAgent` defaults to unlimited) to bound runaway loops.

### R9 — Approvals are durable-suspended with structured correlation (closes the approval-mechanics gap)

A pending approval **suspends the run as a durable workflow** (WDK hook), not a blocked process — so a multi-hour wait survives restarts and costs nothing while idle. Each approval carries an **id**; Sunny presents the request with that id and accepts a structured reply (e.g. a yes/no plus the id, or a tappable affirmation). Ambiguous replies are re-prompted; the hook **default-denies on timeout** (D-SEC3).

### R10 — Smart-mode risk triage runs on a cheap model (sharpens D-SEC3)

The "smart" risk-assessor uses a **cheap fast model (Haiku-class)**, not Opus, to keep per-action latency/cost low. Hard-gated categories (money / destructive / act-as-Devon) bypass it and always prompt regardless.

### R11 — Memory cold-start / onboarding (closes the first-run gap)

On first run, `USER.md`/`SUNNY.md` are seeded by Devon (hand-written starter `USER.md`) and refined through an **onboarding conversation** where Sunny asks and records durable facts. Memory is **global to Devon**; the recent-message *window* is per thread/channel.

### R12 — Double-text steering, not kill (PR comment on durable-execution)

A new owner message arriving while a run is in flight on that thread should **steer** the run, not kill it. Researched support: this is *not* first-class in the Vercel AI SDK, but the clean, supported pattern is a **per-thread steer-buffer drained by `prepareStep`** — `prepareStep` runs before each step and can replace the messages sent to the model, so a newly-arrived message is spliced in at the next step boundary (folding into the current thinking). `abortSignal` abort-then-restart is reserved for messages that *invalidate* the task. (First-class steering exists in Anthropic's Managed Agents / Agent SDK via a server-side message queue + `interrupt`, but adopting those would move the agent loop + session state onto Anthropic's infra — conflicting with the self-hosted, AI-SDK-owns-the-loop design. So we build the steer-buffer ourselves.) This refines R7: per-thread runs are not just *serialized* — an in-flight run **absorbs** the next message rather than queuing a separate run. Specified in `durable-execution`.

### R13 — Permissioning lives at the command/skill layer, not per-activity tools (PR comment on tool-access)

Supersedes the "dedicated gated tool per permissioned activity" framing. Bash is the universal capability surface; permissioning is a layered command model (D-TA1): deny-by-default AST-based command policy + skill-scoped allowlists + smart-mode triage + hard blocklist + **sandbox/egress containment** + per-command `op run` credential injection. Prior art: Claude Code permission rules/hooks + `allowed-tools`, Hermes smart-mode + blocklist, OpenClaw/Goose/OpenHands. Key honest caveats baked into the design: (1) command-string classification is unreliable — pattern rules *route*, containment *contains*; (2) the **lethal trifecta** is the governing risk — Sunny will hold private data + untrusted input (web/email) + an exfiltration path simultaneously, so the uncertain middle must reach human approval, credentialed actions stay hard-gated, and egress control is load-bearing. The "how far to sandbox" question is resolved by R14.

### R14 — Taint-tracking + step-up auth instead of blanket sandboxing (PR follow-up on R13)

Devon's point: sandboxing the agent defeats its ability to do devops on its own host. Resolution: don't sandbox by default. **Track command provenance** and gate on taint. **Clean** commands (Devon-directed, no untrusted content in context) run under the normal policy with full host access. **Tainted** commands (produced while untrusted web/email/skill content is in context) require **step-up "2FA" approval** — a high-friction, provenance-flagged confirmation with a real second factor so it can't be rubber-stamped; credentialed/destructive tainted commands get the strongest confirmation or are refused. **Unattended runs** (no human to step up) block tainted commands and defer to Devon, or use a *targeted* sandbox only for that case. **Egress control** remains a cheap, non-intrusive backstop. This replaces "sandbox all untrusted-derived commands" — sandboxing is now the fallback for the unattended case, not the everyday boundary. (Honest limit: step-up auth is a weaker *technical* boundary than a sandbox — a fully-compromised agent plus an inattentive human can still be socially engineered — so provenance flagging in the prompt and egress control matter.) Reflected in the `tool-access` containment requirement.



