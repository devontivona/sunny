# Tasks — unified-voice-layer

> Build plan. D-VL* decisions are in this change's `design.md`. Phases 1 and 2 are the
> substance; each is independently shippable. Phase 3 is surface + teaching; Phase 4 is the
> live-state deploy choreography (needs Devon's restart window).

## Phase 1 — The voice module (speech contract derived, not hand-written)

- [x] 1.1 Create node-free `src/agent/voice.ts`: `voiceBlock({ lane, audienceSubject, ownerName })`
      generating the speech-contract prompt lines (verbatim-one-message, presence-means-silence
      sentinel per lane, private inter-tool text, `(subagent)`/`(scheduled)` report addressing
      rule, no delivery-mechanics narration — rules only, no examples per
      prompt-examples-become-output), and `finalizeSpeech(text)` returning
      `{ reports, final, sentinel }` (extractReportBlocks + lane sentinel via the existing
      `stripSentinel`). Unit tests for both halves, including the PR #30 ack-framing sentence
      preserved byte-identical in the conversation lane.
- [x] 1.2 Adopt in `src/agent/prompt.ts`: `buildSystemPrompt` (speaker lane — replaces the
      hand-written silence/verbatim bullets in `howYouSpeakText`), `buildJobPrompt` (reporter
      lane — replaces the PR #73 delivery paragraph; report-shaped output per D-VL7),
      `buildSubagentPrompt` (reporter lane — replaces its "How you report" block). Prompt unit
      tests updated; assert all three embed the same addressing rule.
- [x] 1.3 Adopt `finalizeSpeech` in all three workflows: `conversation.ts` finalizeTurn (feeds
      `classifyTextDelivery` as today), `subagent.ts` terminal (replaces inline
      extractReportBlocks + stripNoReport), `scheduledJob.ts` (replaces the PR #73 stripNoReply
      call; sentinel becomes `<no-report/>` with the lane). Delete the now-unused per-profile
      parsing. Full unit + workflow suites green.

## Phase 2 — One speaker: scheduled results become reports

- [x] 2.1 Route a delivering scheduled run's terminal text through the report path: in the
      bus, a scheduled run's terminal deliver to a bound thread becomes append-as-attributed-
      inbound (`<label> (scheduled): …`, `sanitizeLabel`) + wake — the `reportToParent`
      mechanism with the audience's thread as parent (D-VL1/2). `household` stays record-only,
      no wake. `recordRun` (raw output → `schedule_runs`) unchanged and BEFORE the report step.
- [x] 2.2 Retire `send_image` from scheduled runs (D-VL9): drop the tool from the scheduled
      profile; the reporter voice block says to include produced file paths in the report; the
      conversation relay sends media via its own `send_image`. Update scheduledJob tests.
- [x] 2.3 Relay-turn duties (D-VL8): the conversation lane's voice block gains the fold-
      against-thread rules (summarize in voice, don't re-announce the just-discussed, don't
      interrupt an active exchange with low-value updates, `<no-reply/>` allowed). Covers
      `(subagent)` and `(scheduled)` reports with the same sentences — this is also the
      pathology-2 fix.
- [x] 2.4 Workflow tests: a delivering scheduled run's output arrives as an attributed inbound
      on the audience thread and wakes a relay turn (no direct gateway send); the relay turn's
      reply is what reaches the gateway; a `<no-report/>` scheduled run wakes nothing; a
      household run records only; family-correct (a Kate-audience schedule wakes Kate's
      thread). Regression: the pathology-1 shape (notes + sentinel) delivers nothing and the
      pathology-2 shape (report answered in-thread) is exercised by a scripted relay turn
      asserting the reply addresses the human.
- [x] 2.5 Update `durable-execution` invariant consumers: dashboard Schedules/Jobs views label
      the relay chain (run → report → relay turn); `observeScheduledRun` and the watchdog
      unchanged (they watch the run, not the relay).

## Phase 3 — Audience surface + teaching

- [x] 3.1 Standing-schedule frontmatter `audience:` key (`person:<name>` | `household`;
      absent → owner) in `src/scheduler/index.ts` parse/serialize; one-shot loader migration
      of legacy `outputTarget:` (rewrite file, log once, then refuse the key); DB one-shot rows
      keep the `audienceForSchedule` derivation (no destructive migration). Migrate
      `agent/builtin/schedules/dreaming.md` in-repo.
- [x] 3.2 `schedule_create` gains `deliver_to: <roster name> | 'nobody'` (default: current
      subject) → `person:` | `household` (D-VL6); `scheduleCreateStep` plumbs it; description
      rewritten around reports + the artifact-vs-message decision rule; `for` param folded into
      `deliver_to` (one addressing arg, roster-validated). Catalog + scheduleTools workflow
      tests updated.
- [x] 3.3 Delegation skill: schedules section rewritten — reports not texts, `deliver_to`
      decision rule, conditional-report prompt guidance ("report only if X; otherwise exactly
      `<no-report/>`"), audience/authority vocabulary aligned with the code (D-VL6/7). Heartbeat
      skill's interrupt-avoidance step simplified to advisory (D-VL8) — note: lives in the
      state repo, coordinate with Phase 4.
- [x] 3.4 Sweep for retired vocabulary: no live code path reads `outputTarget` except the
      legacy shims; grep-clean `user|silent` frontmatter references from docs/dashboard copy.

## Phase 3b — The audience collapse (folded in 2026-07-15, D-VL10)

- [x] 3b.1 Collapse the Audience type to `nobody | agent(mailbox) | chat(mailbox)` with
      `mailbox = byPerson | byThread` (`src/agent/audience.ts`); `subjectName` /
      `scheduleAudience` / `audienceForSchedule` derive from the mailbox; stored encoding
      gains canonical `nobody` (`household` = legacy alias, normalized at parse and by the
      load-time file rewrite; dreaming.md migrated in-repo).
- [x] 3b.2 Bus dispatch on the audience kind (`deliver` in runShell): nobody → record-only;
      agent → attributed report via `reportToParent` (identity REQUIRED — unattributed agent
      delivery throws); chat → gateway. Attribution moved out of the audience onto the run's
      identity (`{ id?, name, kind }`): subagent + scheduled profiles pass identity; the
      `parent` audience kind is deleted.
- [x] 3b.3 Tests + vocabulary sweep: audience unit tests, scheduledJob/scheduleTools workflow
      tests, scheduler integration tests updated to the collapsed type; `household` survives
      only as the accepted legacy spelling. Spec deltas + design (D-VL10) + proposal updated.

## Phase 4 — Deploy + live-state choreography (Devon's restart window)

- [ ] 4.1 Pre-restart: update the four standing-schedule files (`heartbeat`, `task-assistant`,
      `craft-daily-resource-tagging`, `news-newsletter-processing`) — `audience:` frontmatter
      (news → `household` unless Devon prefers failure reports; others → `person:Devon`) and
      reporter-shaped prompt tails (drop "send via message" / "report what was processed").
- [ ] 4.2 Restart; verify loader migration logs clean; smoke: fire one delivering schedule
      (loopback or wait for heartbeat) and confirm the Langfuse chain
      (scheduled-job trace → attributed report on the thread → relay conversation turn →
      gateway send), plus one silent (`household`) firing recording without waking.
- [ ] 4.3 Sync deltas to main specs (opsx:sync) and archive the change.
