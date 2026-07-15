# Design — Unified voice layer (one speaker, one speech contract)

> Only a conversation turn talks to a human; every autonomous run produces a report. One shared
> module derives each run's speech contract (prompt block + terminal parser) from its RunSpec,
> and the schedule surface speaks audience instead of the retired `outputTarget`. The delivery
> bus, authority model, and WDK shell are unchanged.

## Context

The run-audiences change built the runtime half of "runs are one shell over a RunSpec": one
delivery bus, derived toolsets, monotone authority. The *model-facing* half was never built —
each profile hand-writes its own speech contract (`buildSystemPrompt` / `buildJobPrompt` /
`buildSubagentPrompt`) and hand-parses its own terminal text (`conversation.ts` stripNoReply +
classify + backstop; `subagent.ts` extractReportBlocks + stripNoReport + fallback;
`scheduledJob.ts` — nothing at all until PR #73). Meanwhile text-as-reply made delivery a
*default effect of ending a turn* rather than an act, which invalidated the spec's "conditional
delivery is emergent, no empty-message convention" and forced the sentinel into existence as an
unspecced, per-profile patch. Three 2026-07-13/14 production pathologies (job meta-narration
texted verbatim; a reply addressed to a subagent delivered to Devon; an unsilenceable hourly
schedule) are this one missing layer surfacing in three profiles. Separately, scheduled runs
compose human-facing prose from a cold context and cannot transition from, or deduplicate
against, the live conversation — a quality ceiling no prompt fix can raise.

## Goals / Non-Goals

**Goals:** one rule for human egress (only conversation turns speak); one derived speech
contract (prompt block + terminal parse) consumed by every profile; scheduled results mediated
by the audience's conversation loop exactly like subagent reports; the audience concept exposed
on the schedule surface and taught in one vocabulary; specs reconciled with the implemented
model (audience-axis speech, presence-means-silence sentinel).

**Non-Goals:** bus internals, authority/attenuation, gateway, translator, WDK substrate;
mediating deliberate `message` fan-out; merging the two sentinel tokens; a stored RunSpec/runs
table; changing the dreaming/household record-only path.

## Decisions

- **D-VL1 — One speaker.** A human receives text only from a conversational turn on their own
  thread. Every autonomous run's TERMINAL text is a *report*: for a delivering audience it is
  appended to the audience's bound thread as an attributed inbound message and the thread's
  run-supply is woken (the exact `reportToParent` mechanism subagents already use — scheduled
  runs just have a person's thread as their "parent"); for `household` it is recorded only.
  The relay turn is a NORMAL conversation turn: it has history, voice, and judgment (fold,
  defer, summarize, or `<no-reply/>`). Rationale: the subagent path demonstrably produces
  natural messages; the direct path demonstrably cannot (it has no context to transition from),
  and it forces every autonomous profile to carry a human-grade speech contract. Consequence:
  pathology 1 becomes structurally impossible — sloppy job narration lands in a model's
  context, not a human's phone.

- **D-VL2 — Attribution names the lane.** Scheduled reports arrive as
  `<label> (scheduled): …`, subagent reports stay `<label> (subagent): …` — same
  `sanitizeLabel` + speaker-prefix convention, so the relay turn (and the recorded history)
  can always tell a worker's report from the human. The voice block's addressing rule is
  written against the `(subagent)`/`(scheduled)` labels generically.

- **D-VL3 — The voice module.** New `src/agent/voice.ts`, node-free, owning both halves of the
  speech contract, derived from `{ lane: 'speaker' | 'reporter', audienceSubject, ownerName }`:
  - `voiceBlock(spec)` → the prompt lines: who reads your final text; it is delivered verbatim
    as ONE message; a reply containing the lane's sentinel delivers nothing (presence =
    silence); text between tool calls is private working notes; `(subagent)`/`(scheduled)`
    messages are your workers' reports — your reply still goes to your audience, steer workers
    with `message`; never narrate delivery mechanics into the reply. Rules only, no example
    messages (prompt-examples-become-output).
  - `finalizeSpeech(text)` → `{ reports: string[], final: string, sentinel: boolean }` — the
    one parser (report-block extraction + sentinel strip), consumed by all three workflows;
    `classifyTextDelivery` stays in `delivery.ts` and is fed from it.
  `buildSystemPrompt` / `buildJobPrompt` / `buildSubagentPrompt` embed `voiceBlock` and keep
  only genuine framing (interactive vs autonomous vs child). The PR #30 ack-framing sentence
  is preserved verbatim inside the conversation's block.

- **D-VL4 — Sentinel follows the lane; presence means silence.** Speakers (conversation) use
  `<no-reply/>`; reporters (ALL autonomous runs, now including scheduled) use `<no-report/>`.
  One semantics, already implemented in `stripSentinel` (PR #73): the token's presence anywhere
  in the final text silences the whole reply; the raw text persists in the turn row /
  `schedule_runs` for audit. This is now SPEC, not patch: text-as-reply makes delivery the
  default, so silence requires an explicit token — "conditional delivery is emergent, no
  empty-message convention" is formally retired. The scheduled profile's prompt switches from
  `<no-reply/>` (PR #73's interim fix) to `<no-report/>` with the lane.

- **D-VL5 — Audience replaces `outputTarget` on the schedule surface.** Standing-schedule
  frontmatter: `audience: person:<name>` (default when absent: the owner) or
  `audience: household` (silent pipeline job — record-only, no wake). The loader migrates a
  legacy `outputTarget:` key on first read (rewrites the file, logs once); the field is then
  refused. DB one-shot rows keep the existing `audienceForSchedule` derivation (additive
  `audience` column already exists; `output_target` becomes legacy-read-only — no destructive
  migration). Builtin schedule files (`dreaming.md`) migrate in-repo.

- **D-VL6 — `deliver_to` on `schedule_create`.** The model-facing parameter is
  `deliver_to: <roster name> | 'nobody'` (default: the current subject), mapping to
  `person:<name>` | `household`. The description is rewritten around the report model: the
  fired run REPORTS to that person's conversation loop (Sunny relays with context) or to
  nobody (artifact jobs — the product is files/feeds/state, outcomes inspectable in run
  history). Decision rule stated in the description and expanded in the delegation skill:
  artifact-producing → `nobody`; message-producing → a person, and write the prompt so
  reporting is conditional ("report only if X; otherwise reply exactly `<no-report/>`"),
  never "report what was processed".

- **D-VL7 — Scheduled prompts produce reports, not iMessages.** `buildJobPrompt`'s delivery
  paragraph becomes the reporter voice block: compact factual report for the conversation loop
  (what happened, what matters, suggested emphasis), not finished user-facing prose — voice is
  exclusively the conversation's job. The relay turn may quote a report's user-facing line
  when it is already well-formed, but owns the final wording. The four live standing schedules'
  prompt tails are updated to match (drop "send Devon a concise summary via message" /
  "report what was processed" phrasing).

- **D-VL8 — Relay-turn duties live in the conversation profile.** Interrupt-avoidance and
  anti-repeat judgment move where the context is: the conversation voice block tells the relay
  turn to fold a report against the live thread (don't re-announce what was just discussed;
  don't interrupt an active exchange with a low-value update; `<no-reply/>` is always
  available). The heartbeat skill's hand-rolled interrupt-avoidance step is simplified to rely
  on this (its own check becomes advisory, not the safety net).

- **D-VL10 — The audience collapse (folded in 2026-07-15).** One audience concept for every
  run, three values, answering "who reads my final text":
  `nobody` (record-only; the run may still fan out via `message`) ·
  `agent(mailbox)` (the mailbox's conversation loop reads it — an attributed report; the only
  terminal audience a worker can have; absorbs the former `parent`, `thread`, and
  worker-`person` kinds) ·
  `chat(mailbox)` (the mailbox's people read it — gateway speech; reserved for conversational
  turns; spawn surfaces cannot construct it — the one-speaker rule as a constructibility gate,
  like authority attenuation).
  A `mailbox` names a conversation two ways: `byPerson` (logical, roster-resolved at delivery —
  portable, the standing-file form) or `byThread` (physical — groups, created-here context,
  detached inboxes). ATTRIBUTION is not part of the audience: it is the reporting run's own
  IDENTITY (`{ id?, name, kind }`), passed to the bus with the text and stamped as
  `<name> (<kind>): …` on every agent delivery. Stored/frontmatter encoding:
  `person:<name>` | `nobody` | `thread:<id>` (`household` accepted as the legacy spelling of
  `nobody`, normalized on load). Replaces the four-value `thread|person|parent|household` set.
  The chat lane is LIVE, not ceremonial (folded in 2026-07-15): the conversation profile's
  entire reply lane — terminal reply, backstop, translator updates, send_image — speaks
  through `deliver(chatAudience(threadId), …)`, so the bus is the one gateway-speech seam
  (the former `sendStep` is deleted; `deliver` carries content `{text, attachment?}` +
  `{persist}` and returns the SendResult for media-outcome inspection). The `message` tool
  remains the documented addressed-fan-out exception (D-VL9), and `runScheduledJob` rejects
  a chat audience at the input seam.

- **D-VL9 — What deliberately does NOT change.** The `message` tool (addressed fan-out) still
  gateway-sends directly from any profile that holds it — it is deliberate, addressed speech
  with a self-send refusal guard; mediating it is a follow-up only if voice problems appear.
  `send_image` from a delivering scheduled run is retired with direct delivery (an image-
  producing job reports the file path; the relay turn sends it with `send_image` — one less
  autonomous egress). The recovery backstop, translator cadence, steering, and compaction are
  untouched.

## Risks / Trade-offs

- **A relay turn may under-report.** The conversation model could drop a detail the job meant
  to surface. Mitigations: reports carry "suggested emphasis"; raw output is always in
  `schedule_runs`; the delivery backstop still catches an abnormal relay turn. Accepted — it is
  the same judgment we already trust for subagent reports.
- **Double-generation cost/latency.** One extra conversation turn per delivered scheduled
  result (~27k effective cached input at current numbers, seconds of latency on a schedule
  firing). Negligible at current volume; silent jobs add nothing.
- **Live-state migration.** Four standing files + one builtin file change format at the same
  deploy as the code; the loader's one-shot `outputTarget` migration covers stragglers and any
  files restored from older state-repo clones.
- **Report loops.** A relay turn is a normal turn and could in principle spawn work whose
  report wakes another turn. Existing guards (schedules/children cannot schedule or delegate;
  relay turns can) keep the graph shallow; no new mechanism.

## Migration

1. Code + specs land together (this change).
2. Deploy window (Devon-approved restart): loader migrates any `outputTarget:` frontmatter;
   the four standing schedules' prompt tails are hand-updated to reporter shape in the same
   window; `dreaming.md` migrated in-repo with the code.
3. First firings after deploy are watched in Langfuse (`scheduled-job` traces now chain into a
   conversation relay turn on the audience thread).
