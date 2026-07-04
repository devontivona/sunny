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

- `fewshot`: poisoned **12/20 (60%)** vs baseline 28% — effect confirmed at N=5
  (smalltalk-poisoned 5/5, real-inbox-clarify 4/5; meta-poisoned still hard 1/5).
  Clean+live 46/55 (84%): silence-when-nothing-to-say 2/5 and multiturn-trip 2/5
  are the soft spots — the canned block slightly perturbs live long-multi-turn
  and silence behavior. Copy iteration target, not a disqualifier.
- `envelope+fewshot`: TBD (rerun in flight after the truncation bug below).
- `fewshot × real-batches`: TBD (backfill in flight).

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
   reports PASS with a truncated scorecard. Timers are now ref'd.
3. **Eval world ran real background jobs** — `research-starts-job` spawned a live
   research job (real model spend; its zombie blocked PGlite teardown). The eval
   runtime now sets `stubJobs` (same pattern as delegation's absent `spawnChild`).
4. **Scorecards now checkpoint incrementally** per case; a mid-run death keeps
   completed data. `EVAL_CASES` regex filters cases; `EVAL_TIMEOUT_MS` bounds the
   vitest test; cost caps bound spend (judge calls still unmetered — flat ~$0.01–
   0.03/graded run extra).
5. **Do not run two eval processes concurrently** (suspected Local-World
   interference; unproven but cheap to respect).
6. **Seed audit** (`npm run eval:audit`): the suspected seeding taint was NOT
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
