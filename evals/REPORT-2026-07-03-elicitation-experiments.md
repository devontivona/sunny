# Elicitation experiments — 2026-07-03/04

Session goal: reduce how often the model writes user-directed language in raw text
(scratch) instead of calling `send_message`. Three planned experiments (prompt
reframing, few-shot exchanges, eval hardening + a model/config grid) plus a
two-pass architectural reference arm. All interventions are config knobs,
default-off; production behavior is byte-identical until a knob flips.

## Headline finding: elicitation failure is imitation, not misunderstanding

The hardened eval separates history tiers, and the tiers tell the story
(baseline, Sonnet 5, N=10 effective):

| History the graded turn sees | Elicitation pass rate |
|---|---|
| live / hand-seeded clean | **~95–100%** |
| seeded-poisoned (real captured misses replayed as scratch-only turns) | **0–40%** |

Identical conversation arcs flip from perfect to broken when the in-context
history shows the assistant "replying" in scratch. The model does not
misunderstand the delivery contract — it imitates precedent. Two corollaries:

1. **Misses are self-propagating in production.** A recovered turn persists its
   original scratch alongside the appended recovery send, so each miss leaves a
   partial bad exemplar in the window. (Open lever, not built — Devon previously
   opted to keep scratch in history: sanitize/transform scratch when persisting a
   *recovered* turn, so the poison doesn't compound.)
2. **Interventions only work if they compete in the same modality as the poison
   (examples), or bypass the fight entirely (composer).** See the matrix.

## Screening matrix (Sonnet 5, elicitation minus real-batches, N=2/cell)

| Cell | Clean+live | Poisoned | Cost | Read |
|---|---|---|---|---|
| Baseline (N=10) | 95% | 28% | — | reference |
| `promptVariant: gateway` | 91% | 25% | $1.99 | no effect — prose loses to examples |
| `promptVariant: diary` | 95% | 0% | $2.07 | no effect / possibly worse |
| `inboundEnvelope` | 73% ⚠️ | 38% | $2.57 | small poisoned gain; **breaks silence** (enveloped "👍"/"thanks" reads as demanding a reply — both ack cases 0/2) |
| `fewshot` | 86% | **62%** | $1.92 | **winner** — good examples dilute bad ones |
| `thinking: off` | 95% | 25% | **$1.12** | behavior-neutral, ~45% cheaper; slightly more user-addressed scratch |
| `composerAlways` (two-pass ref) | **100% delivery** | **100% delivery** | $1.07 | ceiling by construction; silence held 5/6; voice = Haiku compose |

Notes:
- The composer row is read on delivery rate (`delivered-via-send_message`), not
  case pass — `elicited-without-recovery` fails by definition in that mode.
- Experiment 1 (Gateway/Diary framing) is a bust: system-prompt reframings,
  however phrased, did not move the poisoned tier. The failure mode lives in the
  message history, not in prompt comprehension.

## Confirmation (N=5)

- `fewshot`: poisoned **15/25 (60%)** vs baseline 28% — effect confirmed at N=5
  (smalltalk-poisoned 5/5, real-inbox-clarify 4/5, real-batches 3/5 ≈ baseline;
  meta-poisoned still hard 1/5). Clean+live 46/55 (84%):
  silence-when-nothing-to-say 2/5 and multiturn-trip 2/5 are the soft spots.
- `envelope+fewshot`: **poisoned 13/15 (87%)** on the miss-chains — incl.
  **meta-poisoned 5/5**, the case at 0% in every other config — with silence
  restored (ack-thanks 5/5) and clean+live 51/55 (93%). Clearly synergistic:
  envelope reinforces at the recent end, fewshot supplies the good exemplars and
  the stay_silent demonstration that patches the envelope's silence break.
  Real fixtures for this cell: **real-inbox-clarify 4/5** (baseline 6/10 —
  improved on the production-history case too); real-batches UNMEASURED for this
  cell (two attempts lost to the vanishing-case bug, infra №7; fewshot's own
  real-batches number was ~neutral at 3/5 vs baseline 4/5, so low information
  loss).

## Hand-inspected transcripts (fewshot cell)

Sanity checks on real transcripts (EVAL_DUMP_DIR) confirmed the wins and caught
two few-shot-induced pathologies — **pre-ship copy iteration items**:

1. **stay_silent spam after sending** — up to 4 consecutive `stay_silent()` calls
   following a send in one turn. The "every turn ends with send_message or
   stay_silent" checklist gets literalized into "close the turn by calling
   stay_silent". Fix candidates: a line in `STAY_SILENT_SPEC` ("never call this
   after send_message in the same turn"), and don't END the few-shot block on the
   stay_silent exchange.
2. **Hallucinated dialogue turn** — after a real send, the model sent a second
   bubble answering a user reply that never happened (played both sides). Rare
   but user-visible; watch for it when iterating the block.
3. Positive: on trivial turns scratch is now often EMPTY (ideal with thinking
   on); poisoned-history turns show clean single sends; the silence case shows an
   explicit `stay_silent()` call. Residual dual-channel: occasional user-addressed
   post-send scratch ("Let me know if…") — the advisory graders count these.

## Decision gate (from the session plan)

Tool-as-voice stays if a prompt-side config reaches ≥~90% poisoned-tier primary
elicitation. Current best (fewshot) is at 60% — well above baseline, well below
the composer's 100%-by-construction. Recommended read: ship `fewshot: true` (and
possibly envelope+fewshot pending confirmation) as the near-term config, treat
the composer arm as the fallback architecture if the poisoned tier stays the
dominant real-world failure mode, and consider the recovered-turn scratch
sanitization as the highest-leverage next intervention (it attacks the poison at
its source instead of counteracting it).

## Infrastructure findings (all fixed on this branch unless noted)

1. **Hung model stream / parked run** — a turn can hang >70 min with no client
   timeout (Anthropic SSE pings defeat undici's bodyTimeout). Evals: per-run
   watchdog (`EVAL_RUN_TIMEOUT_MS`, per-case `timeoutMs` override). **Production
   exposure remains OPEN**: a hung turn silently blocks its thread until restart.
2. **Unref'd watchdog = silent truncation** — when a run parks, an unref'd timer
   may be the only live handle; Node drains, the process exits cleanly, vitest
   reports PASS with a truncated scorecard. Timers are now ref'd. (Transcript
   dumps for hand inspection: `EVAL_DUMP_DIR`.)
3. **Eval world ran real background jobs** — `research-starts-job` spawned a live
   research job (real model spend; its zombie blocked PGlite teardown). The eval
   runtime now sets `stubJobs` (same pattern as delegation's absent `spawnChild`).
4. **Scorecards now checkpoint incrementally** per case; a mid-run death keeps
   completed data. `EVAL_CASES` regex filters cases; `EVAL_TIMEOUT_MS` bounds the
   vitest test; cost caps bound spend (judge calls still unmetered — flat ~$0.01–
   0.03/graded run extra).
5. **Do not run two eval processes concurrently — confirmed mechanism**: the
   Local World is a cross-process singleton (a second `npm run eval` QUEUES on
   the world lock, and interleaved access corrupts run storage →
   `WorkflowRunNotFoundError` aborts the scorecard mid-run).
6. **Zombie steps could boot the PRODUCTION runtime inside the eval process** —
   the scariest find: after a case's teardown deleted the injected test runtime,
   a late-waking step's `getRuntime()` fell through to the real boot path (real
   Sendblue gateway + scheduler + `DATABASE_URL`). Observed 4× on 2026-07-04; no
   messages went out only because the processes died before a scheduler tick.
   Fixed: the harness now leaves a sandboxed TOMBSTONE runtime (fresh FakeGateway
   + torn-down store) in place after every case.
7. **OPEN eval bug: real-batches intermittently vanishes from scorecards** — the
   vitest test reports PASS, no error, no watchdog, but the case (sometimes the
   whole card) never lands. 3× when following other cases, 1× solo (with
   envelope+fewshot); completed successfully solo twice. Consistent tell:
   "Tests closed successfully but something prevents Vite server from exiting"
   prints on EVERY eval run — suspect a WDK Local-World ↔ vitest interaction
   that can resolve/abandon the test promise mid-flight on the token-heaviest
   fixture. Needs a dedicated debugging session; until then treat any scorecard
   missing an expected case as suspect and re-run that case solo.
8. **Seed audit** (`npm run eval:audit`): the suspected seeding taint was NOT
   real (assistant seeds already persist as `send_message` tool calls — pinned by
   tests/seedHistory.integration.test.ts); synthetic elicitation cases now drive
   all prior turns live, and seeding is reserved for deliberately-pinned
   (clean/poisoned) history, tagged and reported per tier.

## Reproducing

- Baseline: `EVAL_DIMENSION=all EVAL_N=5 npm run eval` (default cell gates on
  evals/baseline.json; grid cells don't).
- One cell: `EVAL_FEWSHOT=1 EVAL_DIMENSION=elicitation EVAL_N=5 npm run eval`
- Grid sweep: `npm run eval:grid` (EVAL_GRID_* axes, EVAL_GRID_DRY=1 to preview).
- Knobs: EVAL_MODEL, EVAL_THINKING, EVAL_EFFORT, EVAL_PROMPT_VARIANT,
  EVAL_ENVELOPE, EVAL_FEWSHOT, EVAL_COMPOSER, EVAL_RECOVERY_MODEL, EVAL_CASES,
  EVAL_N, EVAL_COST_CAP_USD, EVAL_RUN_TIMEOUT_MS, EVAL_TIMEOUT_MS.
