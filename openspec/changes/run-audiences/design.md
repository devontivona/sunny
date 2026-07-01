# Design — Run Audiences (who a run is for) & authority attenuation

> Split the overloaded `threadId` into a logical **Audience** and a physical **Thread**, give
> every spawned run a **RunSpec** with an attenuated **authority** set, and derive prompt framing
> from **who the run is for** instead of hardcoding the owner. The durable execution shell
> (`WorkflowAgent` / `runShell.ts`) is unchanged; only the binding seam that feeds it changes.

## Context

The interactive turn is a live conversation, where history + participants + delivery all coincide
in one thread — so fusing them in `threadId` is correct there. The four durable profiles
(conversation, background job, scheduled job, subagent) already share one execution shell
(`streamAgent`), but each hand-assembles its context / recipient / toolset ad hoc, and jobs borrow
a thread purely as a delivery address while a hardcoded owner-framed `buildJobPrompt` supplies the
identity. That is the overload: the execution layer has one clean noun (the run); the **binding
layer has none**.

The `durable-main-loop` migration (`9d0654b`) exposed it by regressing self-scheduling out of
existence (see `proposal.md`). Fixing that well means naming the binding layer, not re-adding a
tool to a list that will drift again.

## Goals / Non-Goals

**Goals:** one noun for "who a run is for" (Audience) that resolves to a delivery Thread; one rule
for "what a run may do" (authority ⊆ creator, explicit at spawn); prompt framing + tool-gating
derived from those instead of from the profile or the thread; the self-scheduling regression fixed
as a consequence, not a special case; family-correct jobs (framing, delivery, ownership).

**Non-Goals:** a first-class `runs` table; within-tool parameter attenuation; state/webhook
triggers; cross-system agent identity; changes to the `WorkflowAgent` shell or WDK substrate.

## Decisions

- **D-RA1 — Three layers, not one string.** A run is the agent loop over three orthogonal inputs:
  **context** (what fills `messages` + which memory docs load), **audience** (who it is for →
  where output goes), and **authority** (which tools it may use). `threadId` conflated the last
  two (and, in conversations, the first). Name them; stop deriving all three from a string.

- **D-RA2 — Audience: the logical recipient.** `Audience = person(userKey) | household(deliver:
  'agent-choice' | 'silent') | thread(threadId) | parent(parentThreadId)`. It **resolves** to a
  Thread for delivery (person → their DM via `bot.openDM`; thread → itself; parent → the parent's
  inbox; household → the agent chooses recipients via `message_person`, each resolving to that
  person's DM). Delivery **always grounds out in a channel-bound Thread** — that is the physical
  address, and is deliberately not abstractable away. Replaces the `user`/`parent`/`silent` output
  target (`silent` → `household(silent)`; `parent` → `parent(...)`; `user` → whatever the audience
  resolves to). **We keep the name "Audience"** — see Naming.

- **D-RA3 — Thread: the physical mailbox.** A Thread is a durable message log plus an **optional**
  channel binding: **`bound`** (backed by a real adapter — iMessage/Sendblue; delivery = the
  gateway) or **`detached`** (no channel — a subagent inbox or a household run's workspace; used
  for steering/logging, never a human destination). Detached threads already exist by convention
  (subagent `childThreadId`); this makes the kind explicit. Align with the Chat SDK `Thread`
  model and serialize the SDK's way (`SerializedThread`) rather than hand-encoding threadId
  semantics; a detached thread can be backed by `@chat-adapter/state-memory` (already a dependency).

- **D-RA4 — Principal ≠ Audience (behalf ≠ recipient).** The **Principal** is the subject a run
  acts for; it drives prompt framing, which memory it reads/writes, and **ownership**. Usually the
  principal equals the audience's subject; they diverge when a creator acts for someone else (Devon
  sets a reminder whose principal is Kate). **Ownership follows the principal, plus the owner
  always** (Kate can list/cancel `principal=Kate` runs; the owner sees and cancels everything).
  This falls out of the stored audience/principal — no separate ACL.

- **D-RA5 — Authority: monotone subset attenuation (ocap).** Every spawned run carries an
  **authority** = a set of named grants (tool capabilities). Invariant: `authority(child) ⊆
  authority(creator)`, **endowed explicitly at spawn** — **no ambient authority** (a run never
  inherits the shell's tools implicitly). The spawn relation is a **derivation tree** (enables
  cascade-revoke / audit lineage). This generalizes durable-execution's existing "least-privilege
  child runs" from delegated children to **all** spawned runs (scheduled jobs included), and
  **replaces the bespoke anti-recursion guard**: a scheduled run simply isn't endowed with the
  `schedule` grant by default (with the derivation-tree depth cap as backstop), rather than a
  special case checked in code.

- **D-RA6 — Enforce with the real SDK mechanism.** `activeTools` is advisory in-loop narrowing,
  **not** a trust boundary. The boundary is which `tools` the child agent is **constructed** with
  (a literal subset); `activeTools` / `prepareStep` narrow within the loop; `needsApproval` gates
  individual grants when wanted. Assert `⊆` at spawn in app code (no library enforces it).

- **D-RA7 — One shell, one RunSpec.** `RunSpec = { audience, authority, brief, model }`.
  Conversation / job / schedule / subagent are the same `WorkflowAgent` shell over a RunSpec; a
  single `resolveAudience(audience) → { instructions, contextDocs, deliver, tools }` step replaces
  the four bespoke `buildSetup`s. `buildJobPrompt`'s hardcoded owner framing is removed; framing is
  derived from audience/principal (person-framed for `person`, steward-framed for `household`,
  participant-aware for `thread` — reusing what `setupTurn` already does for conversations). Net
  code **deletion**, not addition.

- **D-RA8 — Tools: sharp verbs, shared args, unified lifecycle.** Keep three distinct creation
  verbs — `start_job` (now, async, replies to the thread), `delegate_task` (now, reports to me),
  `schedule_create` (later/on a trigger, for an audience) — because an LLM selects far more
  reliably among a few tightly-described verbs than from one polymorphic `spawn_run(mode, …)`. But
  they **share the `{ audience, authority }` argument shape** (promoting `delegate_task`'s existing
  `toolset` into the shared `authority` arg), and inspection/cancel unify into audience-agnostic
  **`list_runs` / `cancel_run`** spanning schedules + jobs + subagents.

- **D-RA9 — Skills: one skill for the whole spawn taxonomy.** The decision "spawn a run: now or
  later? for whom? with what least authority?" is a single judgment. Extend the subagent-only
  `delegation` seed into one **delegation & scheduling** skill; do not write three near-duplicates.
  Optionally filter the skill index by a run's authority (a memory-only run isn't shown a skill it
  can't act on).

- **D-RA10 — Household runs may proactively message household members.** A `household` run is a
  **fan-out hub**: it holds `message_person` (roster-scoped — refuses arbitrary numbers) and may
  text any roster member unprompted, each delivery resolving to that member's channel-bound DM.
  (Owner-configurable / approval-gated variants are possible via `needsApproval` but not required.)

- **D-RA11 — Storage: minimal (audience/principal/authority on existing rows).** Add `audience`,
  `principal`, and `authority` columns to `schedules` and `subagent_links`; `start_job` passes its
  RunSpec inline (fire-and-forget). **No `runs` table** — RunSpec is a *type*; two of its four
  fields already exist as columns (`prompt`/`task`, `model`). Promote to a ledger table only if a
  unified activity/ownership view later demands it (the embedded shape migrates cleanly).

- **D-RA12 — Time-triggered only; failure detection already present.** Triggers stay
  `once`/`interval`/`cron`. Conditional "remind if X hasn't happened" is expressible today via
  **empty-reply-means-no-send** (already how `silent`+non-empty works) *provided the run has the
  authority to read the state* (hence D-RA5 letting a schedule hold `host`). Checkpointing alone is
  not durable execution, but Sunny already has the failure-detection layer (delegation watchdog,
  scheduler ticker, startup recovery pass) — state/webhook triggers deferred (mirror A2A task
  lifecycle when added).

- **D-RA13 — Naming, on the merits.** Keep **"Audience"** — it reads naturally, handles the plural
  (household) case that "recipient" fumbles, and has **no in-stack collision** (no AI SDK / Chat
  SDK / WDK use of the word). The ActivityStreams `audience` semantics are irrelevant: we do not
  implement ActivityPub, so no reader of this codebase meets both meanings. We *do* rename where a
  collision is **in our stack**: **`workspace` → `detached`** (Chat SDK `ChannelVisibility` has a
  `"workspace"` value) and, for the ocap sense, prefer **"authority"/"grant"** over "capability"
  (MCP uses "capabilities" for its `initialize` handshake, and we run MCP).

## The model

```
          RunSpec { audience · authority · brief · model }     one value, four profiles
                                  │ runs on
                                  ▼
                    one durable shell (WorkflowAgent)
   LOGICAL  ─────────────────────────────────────────  who / what
     AUDIENCE   person · household · thread · parent
        │ resolves (openDM / getParticipants)
   PHYSICAL ─────────────────────────────────────────  where bytes land
     THREAD     bound (adapter-backed) | detached (state-memory)
     AUTHORITY  creator ⊇ child ⊇ grandchild   (monotone; explicit endowment; derivation tree)
     PRINCIPAL  the subject a run acts for → owns it
```

## Scenario mapping

| scenario | audience | thread | context | authority (⊆ creator) | delivery → lands | stored | owned by |
|---|---|---|---|---|---|---|---|
| owner live DM | thread(T) | T (bound) | T window + USER + core | full owner set | T → owner iMessage | messages | — |
| family DM (Kate) | thread(T) | T (bound) | T window + Kate doc | full (family trusted) | T → Kate iMessage | messages | — |
| owner+family group | thread(T) | T (bound, group) | T window + each doc | group-limited | T → the group | messages | — |
| start_job | thread(T) | T (bound) | brief; framed from T's participants | ⊆ creator | T → whoever T is | inline | — |
| subagent | parent(pThread) | child inbox (detached) | brief | ⊆ parent | parent inbox → folds up | subagent_links | — |
| Leo reminder | person(kate) | resolved at fire | Kate doc + core | {host, send} ⊆ Kate's | resolve Kate → her DM (empty = silent) | schedules | Kate + owner |
| follow-up sweep | household(agent-choice) | household inbox (detached) | core + index + open loops | {relay, send, memory} | message_person → each DM | schedules | owner |
| nightly consolidation | household(silent) | household inbox (detached) | core (shared) | {memory} | nobody (records only) | schedules | owner |
| per-person briefing | person(p) × N | resolved per p | p's doc + core | {memory, send} | resolve p → p's DM | schedules (N rows) | each p + owner |

## Prior art & library alignment

- **Actor model (Erlang/Akka):** the logical *address/reference* vs the physical *mailbox* is our
  Audience vs Thread; a stable reference outliving the behavior instance is why `person(userKey)`
  survives a channel switch that a `threadId` would not.
- **XMPP / Matrix / ActivityPub:** XMPP *resource* (one logical recipient, several physical
  landing spots) and Matrix *room* (a shared durable multi-party log) precisely match our
  person-fan-out and our Thread-as-log. ActivityPub resolves logical recipients to physical inboxes
  at delivery time — our `resolveAudience`.
- **ocap / seL4 / POLA:** D-RA5 is seL4's minting rule verbatim (derive with a *subset* of rights,
  never more); "no ambient authority", "attenuation", "derivation tree", "membrane" (future
  within-tool attenuation, D-RA12/Non-Goals) are the adopted vocabulary. Current agent-security
  work (MCP delegation gateways, AWS GENSEC05-BP01) is rediscovering the same invariant.
- **Multi-agent frameworks:** our orchestrator-worker + parent-audience shape is the
  handoff / agents-as-tools pattern (OpenAI Agents, LangGraph subagents, Anthropic's multi-agent
  research: "only the orchestrator talks to the human"). A2A's task lifecycle
  (`submitted → working → … → completed|failed|canceled`) + push notifications is the model to
  mirror if/when we add background-run status + non-time triggers.
- **AI SDK v7 / Chat SDK (installed):** enforcement via `activeTools` / `prepareStep` /
  `needsApproval` on `WorkflowAgent` (D-RA6); Thread/`openDM`/`userKey` as the physical +
  resolution layer (D-RA2/3); Audience itself lives in the gap between the two libraries and stays
  app-level.
