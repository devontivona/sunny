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

**Resolved sub-decisions:**
- **Store = full fidelity.** The persisted `payload` is the whole assistant `UIMessage` incl. *all* tool parts (`memory_write`/`schedule_*`/`start_job`/`send_message`) — lossless, exactly what `readUIMessageStream` yields, good for audit / a future UI.
- **Replay = full to start.** The whole stored `UIMessage` (bounded by the recent-window N) is converted to model messages each turn; this also *retires the synthetic `send_message` reconstruction*. If the window proves noisy/expensive (e.g. re-feeding old `recall_history` outputs), filter heavy tool i/o from the replay (keep scratch + sends) — a later optimization, not now.
- **FTS / `text` projection = inbound text + delivered sends + assistant scratch.** Scratch is indexed so the working-context Sunny didn't say is *recallable beyond the window*, not just available within it (the within-window copy lives in `payload`).
- **`metadata`** = `{ createdAt, model, usage:{in,out,cached,cacheWrite}, delivered, steps }` on assistant turns; `{ createdAt }` on inbound — a minimal precursor to the observability change (trajectories/budget).
- **`generate` → `stream`** is required to assemble `UIMessage`s; it touches prompt-cache logging and `prepareStep` steering (both supported on `stream()`) — re-verified with a probe.
- **Chat SDK `bot.transcripts`:** not adopted (redundant, per-user granularity).

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

*As-built:* both Tier-2 jobs run a `DurableAgent` (`@workflow/ai`) at the workflow level, so each LLM call and tool call is its own durable step — a crash resumes mid-agent from the last completed step rather than re-running the whole agent. Scheduled-job memory tools are step-wrapped so a replay never re-applies a non-idempotent `memory_write`. (`@workflow/ai` is experimental.)

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

Because scheduled runs execute unattended on Opus, each run is subject to a configurable cost/token cap and the scheduler to a rate limit. Exceeding the cap stops the run and notifies Devon rather than silently spending.

*As-built:* only the scheduler-side throttle is implemented here (a per-tick dispatch bound so a backlog can't stampede). The per-run cost/token budget cap + stop-and-notify is deferred to the **observability** change (budget meter), where it belongs; the scheduling spec now only carries the bounded-dispatch requirement.

### Rejected alternatives (scheduling)

- **Infinite self-rescheduling workflow as the only mechanism:** opaque (schedule state hidden in an in-flight run), and exposes WDK's determinism footgun on an unbounded loop. Keep schedule state explicit in a table; a workflow may *implement* a recurrence but isn't the system of record.
- **Letting scheduled runs create schedules (no guard):** invites runaway self-scheduling and cost blowups — explicitly forbidden by D-SC4.
- **A separate scheduler datastore (e.g. the old `cron/jobs.json`):** rejected in favor of the consolidated Postgres instance.

## Risks / Trade-offs (scheduling)

- **Unattended cost:** autonomous runs spend money without a human in the loop. Mitigated by D-SC6 (per-run cap + rate limit) and D-SC4 (no recursion).
- **Missed fires while the host is down:** on restart, due one-shots SHALL run once (catch-up); intervals/cron SHALL resume forward without backfilling every missed occurrence (no thundering herd). This is a policy choice favoring "fire once, move on" over strict backfill.
- **Clock/timezone correctness:** cron is evaluated in Devon's timezone; DST edges are a known sharp corner.

---

> **Split out:** the `security-permissions`, `credentials`, `tool-access`,
> `agent-skills`, `observability`, and `subagents` capability designs were carved
> into their own changes (`security-tools-credentials`, `skills`, `observability`,
> `subagents`). Their design lives there; the post-design audit below is retained
> as the historical record of the original full-scope bootstrap design.

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

*As-built:* the service is a **Nitro** app (the `workflow/nitro` module compiles the `"use workflow"`/`"use step"` directives); routes in `server/`, workflows in `workflows/`. **devbox** supervises it as a systemd *user* service (`Restart=always` + linger → boot survival) and exposes it over HTTPS via a Cloudflare tunnel — this satisfies the always-on requirement, so no hand-rolled systemd unit was needed. Dev runs `nitro dev` (file watcher; ignores the `.swc`/build caches to avoid a rebuild loop); the `nitro build` → `node .output` production hardening is deferred until dev settles. See `README.md` → "Running & deploying".

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



