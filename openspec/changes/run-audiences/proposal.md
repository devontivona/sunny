## Why

A `threadId` currently does **three jobs at once** — it is the conversation history, the identity of who is in the conversation, and the delivery address — because the interactive turn is a live conversation where those genuinely coincide. Background/scheduled/subagent runs borrow a thread to get all three, and inherit an **owner-only framing** (`buildJobPrompt`: "you are Devon's assistant… reply for Devon") that is wrong the moment a family member is involved.

Two concrete failures follow, both live in the archive:

- **Regression:** the `durable-main-loop` migration (commit `9d0654b`) deleted the in-process loop and rebuilt the conversational turn as `workflows/conversation.ts`, but its `buildTools` never re-registered `createScheduleTools`. **Sunny can no longer schedule itself** — it told Kate *"I can't run my own timer in the background"* and fell back to Home Assistant. `ensureConsolidationSchedule` also lost its only caller (fresh installs get no nightly consolidation), and the dashboard tool catalog still advertises schedule tools that don't exist. This violates the existing `scheduling` spec's **Self-scheduling** requirement.
- **Multiplayer gap:** a job fired in Kate's thread frames itself as Devon's and addresses its reply "for Devon"; scheduled/background runs are pinned to a single thread and are not family-aware; the `user`/`parent`/`silent` output-target enum is a partial patch on only the delivery axis.

## What Changes

Introduce one noun for **who a run is for** and one rule for **what it may do**, so the thread goes back to being just a mailbox. The durable execution shell is unchanged; only the binding seam that feeds it changes.

- **run-audiences (new)** — the model: an **Audience** (logical recipient, pure addressing: `person` / `household` / `thread` / `parent`) that resolves to a **Thread** (physical durable log with an optional channel binding: `bound` | `detached`); a single **delivery bus** (`deliver(thread, msg)` dispatching on binding — `bound` → gateway, `detached` → append + wake) that all outward messaging goes through; an **authority** set of grant-name strings governed by **monotone subset attenuation** (a spawned run's authority ⊆ its creator's, endowed explicitly at spawn, no ambient authority) — in which a **messaging grant is what lets a run speak, so silence is structural** (a run with no messaging tool cannot emit); ownership **derived from the audience** (its subject + owner, no separate field); and a single **RunSpec** `{ audience, authority, brief, model }` that conversation / job / schedule / subagent all share.
- **scheduling (modified)** — restore self-scheduling (family-gated, audience-aware); re-seed nightly consolidation as a `household` singleton endowed no messaging grant (structurally silent); reframe the anti-recursion guard as authority attenuation; deliver by resolving the schedule's audience through the bus, not a hardcoded owner thread.
- **durable-execution (modified)** — replace the `user`/`parent`/`silent` **output target** with an **Audience** delivered through the one bus (silence is the absence of a messaging grant, not an output mode; terminal delivery becomes a bus call, so headless output is never stranded); generalize **least-privilege child runs** into **authority attenuation for every spawned run** (not just delegated children).
- **tool-access (modified)** — the three creation verbs (`start_job`, `delegate_task`, `schedule_create`) share one `{ audience, authority }` argument shape; **collapse `message_person` + `message_subagent` into one addressed `message(recipient, text)`** (roster person or my subagent) over the bus, keeping `send_message` as the reply-to-my-audience primitive; unify inspection into `list_runs` / `cancel_run` (schedules + subagents); authority is endowed explicitly at spawn and enforced by subset-`tools` construction + `activeTools`.
- **agent-skills (modified)** — collapse the subagent-only `delegation` seed into one **delegation & scheduling** skill covering the whole spawn taxonomy (now / background / later; for whom; least authority); optionally filter the skill index by a run's authority.

## Impact

- **Fixes the self-scheduling regression** and makes background/scheduled runs family-correct (framing + delivery + ownership).
- Touches `workflows/{conversation,job,scheduledJob,subagent}.ts`, `src/agent/{prompt,instructions,outputTarget}.ts`, `src/agent/tools/*`, `src/scheduler/*`, `src/gateway/*`, `src/db/schema.ts` (add `audience` + `authority` columns to `schedules` / `subagent_links`; a first-class `runs` ledger is **out of scope** — deferred until a unified activity view demands it).
- **Time-triggered only** for now; state/webhook triggers are deferred (mirror A2A's task lifecycle + push model when added).
- Pairs with `security-permissions` (authority attenuation is the ocap substrate its gating rides on) and aligns with `messaging-gateway` (audience resolves to a gateway thread).

## Non-Goals

- A first-class `runs` table (RunSpec stays a type persisted as columns on existing tables).
- Within-tool parameter attenuation (e.g. `bash` scoped to one dir) — the `authority` type is designed to carry constraints, but v1 subsets at the tool-list level only.
- State-condition / webhook triggers; cross-system agent identity.
