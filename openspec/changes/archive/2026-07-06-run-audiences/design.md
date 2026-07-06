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

- **D-RA2 — Audience: the logical recipient (pure addressing).** `Audience = person(userKey) |
  household | thread(threadId) | parent(parentThreadId)`. It **resolves** to a Thread for delivery
  (person → their DM via `bot.openDM`; thread → itself; parent → the parent's inbox; household →
  whichever members the run chooses to message, each resolving to their DM). Delivery **always
  grounds out in a channel-bound Thread** — the physical address, deliberately not abstractable
  away. Audience carries **no notion of whether the run speaks** — that is a communication/authority
  question (D-RA14), not an addressing one; `household` therefore takes no `deliver` parameter.
  Replaces the `user`/`parent` output target (`parent` → `parent(...)`; `user` → whatever the
  audience resolves to; `silent` is no longer an audience — see D-RA14). **We keep the name
  "Audience"** — see Naming.

- **D-RA3 — Thread: the physical mailbox.** A Thread is a durable message log plus an **optional**
  channel binding: **`bound`** (backed by a real adapter — iMessage/Sendblue; delivery = the
  gateway) or **`detached`** (no channel — a subagent inbox or a household run's detached inbox;
  used for steering/logging, never a human destination). Detached threads already exist by
  convention (subagent `childThreadId`); in this change `detached` stays that existing convention.
  Formalizing Thread as a first-class Chat SDK `Thread`/`SerializedThread` (and retiring the
  hand-rolled `isGroupThreadId`) is a **separate, deferred change** — not required for the jobs
  here, since every in-scope delivery grounds out in a `bound` thread.

- **D-RA4 — Ownership follows the audience's subject (no separate Principal).** Who a run acts for
  and who owns it **derive from its audience**, not a separate stored field: `person(kate)` → Kate;
  `household` → the owner; `thread(T)` → T's trusted sender; `parent` → the parent's owner. A run is
  listable/cancellable by that subject **plus the owner always** (Kate can cancel her own runs; the
  owner sees and cancels everything). We considered a distinct `Principal` noun for the "creator
  acts for someone else" case (Devon sets a reminder for Kate) — but there the audience is already
  `person(kate)`, so the subject is recoverable from the audience: no divergence, no extra column,
  no ACL. Introduce a Principal only if a real case appears where ownership ∉ the audience.

- **D-RA5 — Authority: monotone subset attenuation (ocap).** Every spawned run carries an
  **authority** = a set of **grant-name strings** (tool/capability names; WDK-serializable, so it
  rides in the RunSpec). Invariant: `authority(child) ⊆ authority(creator)` (set inclusion),
  **endowed explicitly at spawn** — **no ambient authority** (a run never inherits the shell's tools
  implicitly; a tool existing in-process does not make it invocable). This generalizes
  durable-execution's existing "least-privilege child runs" from delegated children to **all**
  spawned runs (scheduled jobs included), and **replaces the bespoke anti-recursion guard**: a
  scheduled run simply isn't endowed the `schedule` grant by default (the existing delegation depth
  cap remains the runaway backstop). The conversation turn's own authority is the **root** of the
  tree, reified from its trust gates (`trustedDm`/`ownerPresent`) so the first `⊆` check has
  something concrete to compare against. *(Cascade-revoke, audit lineage, and within-tool "membrane"
  attenuation are natural extensions but are **out of scope** here — no in-scope requirement
  exercises them.)*

- **D-RA6 — Enforce with the real SDK mechanism.** `activeTools` is advisory in-loop narrowing,
  **not** a trust boundary. The boundary is which `tools` the child agent is **constructed** with
  (a literal subset); `activeTools` / `prepareStep` narrow within the loop; `needsApproval` gates
  individual grants when wanted. Assert `⊆` at spawn in app code (no library enforces it).

- **D-RA7 — One shell, one RunSpec.** `RunSpec = { audience, authority, brief, model }`.
  Conversation / job / schedule / subagent are the same `WorkflowAgent` shell over a RunSpec; a
  single `resolveAudience(audience) → { instructions, contextDocs, deliver, tools }` step replaces
  the four bespoke `buildSetup`s. `buildJobPrompt`'s hardcoded owner framing is removed; framing is
  derived from the audience (person-framed for `person`, steward-framed for `household`,
  participant-aware for `thread` — reusing what `setupTurn` already does for conversations). Net
  code **deletion**, not addition.

- **D-RA8 — Tools: sharp verbs, shared args, unified lifecycle.** Keep three distinct creation
  verbs — `start_job` (now, async, replies to the thread), `delegate_task` (now, reports to me),
  `schedule_create` (later/on a trigger, for an audience) — because an LLM selects far more
  reliably among a few tightly-described verbs than from one polymorphic `spawn_run(mode, …)`. But
  they **share the `{ audience, authority }` argument shape** (promoting `delegate_task`'s existing
  `toolset` into the shared `authority` arg), and inspection/cancel unify into audience-agnostic
  **`list_runs` / `cancel_run`** spanning schedules + subagents. (Background jobs are fire-and-forget
  with no persisted row — out of scope for `list_runs` until a run ledger exists; D-RA11.)

- **D-RA9 — Skills: one skill for the whole spawn taxonomy.** The decision "spawn a run: now or
  later? for whom? with what least authority?" is a single judgment. Extend the subagent-only
  `delegation` seed into one **delegation & scheduling** skill; do not write three near-duplicates.
  Optionally filter the skill index by a run's authority (a memory-only run isn't shown a skill it
  can't act on).

- **D-RA10 — Household runs may proactively message household members.** A `household` run is a
  **fan-out hub**: it holds the addressed `message` tool (D-RA15, roster-scoped — refuses arbitrary
  numbers) and may text any roster member unprompted, each delivery resolving to that member's
  `bound` thread. A rate/dedup guardrail (so a mis-briefed recurring sweep can't text everyone
  repeatedly) is a **follow-up** requirement, not yet specified.

- **D-RA11 — Storage: minimal (audience/authority on existing rows).** Add `audience` and
  `authority` columns to `schedules` and `subagent_links`; `start_job` passes its RunSpec inline
  (fire-and-forget). Ownership derives from `audience` (D-RA4), so there is **no `principal`
  column**. **No `runs` table** — RunSpec is a *type*; two of its four fields already exist as
  columns (`prompt`/`task`, `model`). Promote to a ledger table only if a unified activity/ownership
  view later demands it (the embedded shape migrates cleanly).

- **D-RA12 — Time-triggered only; failure detection already present.** Triggers stay
  `once`/`interval`/`cron`. Conditional "remind if X hasn't happened" is just the run delivering (or
  not) iff the condition holds (D-RA14/D-RA15) — a headless run returns empty when there is nothing
  to say — *provided it also holds the authority to read the state* (hence D-RA5 letting a schedule
  hold `host`). Checkpointing alone is
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

- **D-RA14 — Silence is the absence of a messaging grant (not an output mode).** Whether a run
  *may* speak is an **authority** question: a run not endowed a messaging grant cannot emit —
  silence is **structural** (guaranteed by the absent tool), not a `silent` flag someone can forget.
  A `household` maintenance run (consolidation) is thus simply endowed `{memory}` and no messaging
  grant. Whether a *granted* run **does** speak is emergent — it delivers, or returns empty when
  there is nothing to say (conditional delivery, e.g. "remind only if Leo hasn't been fed"), exactly
  like a conversational turn choosing to stay quiet. This **corrects an earlier over-reach**:
  silence-as-authority does *not* mean deleting the headless **terminal delivery**. A
  job/scheduled/subagent's final message is still delivered — now as a single **bus** call (D-RA15)
  rather than a bespoke `emitStep`/`rawtext` path — so nothing is stranded and a silent-*success*
  subagent still reports to its parent (rather than emitting nothing and leaving the parent's
  watchdog, which fires only on `returnValue` rejection, waiting forever). The elicitation-miss net
  is the existing **recovery backstop**, hoisted into the one shared finalize and **framed by the
  run's subject** (D-RA4), never hardcoded to the owner.

- **D-RA15 — One delivery bus; two messaging verbs.** All outward messaging collapses to a single
  seam: `deliver(thread, msg)` that **dispatches on the mailbox binding** — `bound` → `gateway.send`
  (reaches the human; their own turn also folds it), `detached` → append + wake (reaches the
  agent-run, folded via `loadSteers`). This replaces the three scattered paths (`emitStep`'s
  `user`/`parent`/`silent` arms, `message_person`'s `gateway.send`, `steerChild`'s inbox append)
  with one. Inbound is *already* single — owner double-text, parent→child steer, and child→parent
  report all fold through `loadSteers`; this makes outbound match. Every bus message carries a
  **`from`** (sender id + label), so a subagent report is attributed `"<label> (subagent): …"` by
  construction (no bespoke `EmitTarget.from*`), and parent→child steering stays the inbound-fold it
  already is (orthogonal to audience-based emit). A run's **terminal delivery is just a bus call** to
  its audience, wrapped once by the recovery backstop — **one finalize for all four profiles**.
  **Tool surface** (messaging, distinct from D-RA8's spawn verbs): `send_message(text)` = reply to
  *my* audience (zero address, the common case); **one addressed `message(recipient, text)`** = send
  to a *named other* entity, where `recipient` ∈ {roster people} ∪ {my running subagents} — this
  **unifies `message_person` + `message_subagent`** (relaying to a person and steering a child are
  the same bus op to a different mailbox). Agent↔agent and agent↔human become the same operation,
  differing only in the transport the binding selects.

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
     THREAD     bound (adapter-backed) | detached (inbox)
     DELIVERY   one bus — bound → gateway.send · detached → append + wake
     AUTHORITY  creator ⊇ child ⊇ grandchild   (monotone set inclusion; explicit endowment)
     OWNERSHIP  derived from audience → its subject + owner
```

## Scenario mapping

| scenario | audience | thread | context | authority (⊆ creator) | delivery → lands | stored | owned by |
|---|---|---|---|---|---|---|---|
| owner live DM | thread(T) | T (bound) | T window + USER + core | full owner set | T → owner iMessage | messages | — |
| family DM (Kate) | thread(T) | T (bound) | T window + Kate doc | full (family trusted) | T → Kate iMessage | messages | — |
| owner+family group | thread(T) | T (bound, group) | T window + each doc | group-limited | T → the group | messages | — |
| start_job | thread(T) | T (bound) | brief; framed from T's participants | ⊆ creator | T → whoever T is | inline | — |
| subagent | parent(pThread) | child inbox (detached) | brief | ⊆ parent | parent inbox → folds up | subagent_links | — |
| Leo reminder | person(kate) | resolved at fire | Kate doc + core | {host, send_message} ⊆ Kate's | bus → Kate's bound DM (delivers iff due) | schedules | Kate + owner |
| follow-up sweep | household | household inbox (detached) | core + index + open loops | {message, send_message, memory} | bus → each member's bound DM (via `message`) | schedules | owner |
| nightly consolidation | household | household inbox (detached) | core (shared) | {memory} — no messaging grant | nobody (structurally silent) | schedules | owner |
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
