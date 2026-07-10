# Tasks: context-lifecycle

## 1. Schema + config

- [x] 1.1 Add `threadCompactions` + `dreamState` tables to `src/db/schema.ts`; generate `drizzle/0012_dreaming.sql` via drizzle-kit; add 0012 to `tests/migrations.integration.test.ts`
- [x] 1.2 Config knobs in `src/config/index.ts`: `compactedWindowMaxRows` (120), `windowTailTokenTarget` (100_000), `dream: { marginMinutes: 30, digestMaxChars: 150_000, summaryMaxChars: 6000 }`

## 2. Reachability (harness)

- [x] 2.1 INDEX invariant: `applyMemoryWrite` topic writes ensure an INDEX stub line in the same serialized write (`src/memory/index.ts`); unit tests (fresh topic → stub; existing line untouched; INDEX-cap overflow best-effort)
- [x] 2.2 Attachment permanence: `execRecall` renders attachment names + saved paths per hit; `mediaSection` prompt rewrite (files persist; how to re-read; drop "you have NO tool"); update `prompt.unit.test.ts`
- [x] 2.3 Projection v2: `finalizeTurn` appends sanity-bounded tool-result extracts (base64/data-URL stripping; ~4k/result, ~100KB/row) via a tested pure extractor; verify `markTurnUndelivered` matching + dashboard previews; switch dashboard `search()` (`src/dashboard/data.ts:311`) to snippets
- [x] 2.4 Recall display: `store.recall` adds `ts_headline` snippet selection; `execRecall` renders `[date] who (in thread) [id:<messageId>]: <snippet>`; integration tests (tool-text findable, snippet not whole row)
- [x] 2.5 `recall_expand(messageId)`: spec in `memorySpecs.ts`, `execRecallExpand` (full rendered row incl. tool outputs + attachment paths, ~20k cap), wire into `memory_read` bundle (`workflows/runShell.ts`), `createMemoryTools`, `catalog.ts` + its unit test; `memorySection` gains the snippets/expand line

## 3. sunny CLI

- [x] 3.1 Frame: `src/cli/index.ts` (thin arg parser, env-file/config bootstrap, non-zero model-actionable errors); `src/cli/dream.ts` with importable `digest/compact/advance` functions
- [x] 3.2 `dream digest`: global-watermark span (exclude `subagent:%`, freshness margin), per-thread sections (attribution, verbatim `row.text`, attachment lines, bounded tool traces from payload scan), prior compaction summary per thread, suggested boundary vs `windowTailTokenTarget` (a ceiling), inter-message lull markers (episode-boundary hints), INDEX lint diff, printed `advance` command, 150k cap with oldest-first partial coveredThrough, IDLE marker; unit tests on the pure renderer
- [x] 3.3 `dream compact`: full validation matrix (internal thread, boundary exists, freshness, **no unanswered at-or-before boundary**, monotonic, length cap) + insert; `dream advance`: `dream_state` upsert; integration tests (PGlite) for the refusal matrix + supersede ordering + advance
- [x] 3.4 Sanity-run the CLI end-to-end against a scratch DB (`npx tsx src/cli/index.ts dream digest`)

## 4. Compaction read side (harness)

- [x] 4.1 `store.latestCompaction(threadId)`; watermark-aware `recentWindow` (post-boundary rows, `compactedWindowMaxRows` cap, legacy 30-row path when no compaction row); integration tests (boundary exclusion, tuple ties, cap overflow, legacy fallback)
- [x] 4.2 `loadPending`: prepend directly-built summary `ModelMessage` (data-not-instructions framing + `cacheControl`); tag last window message with `cacheControl`; R6 derivation untouched; workflow test — conversation replay on a compacted thread (mock sees summary-first prompt + only post-watermark rows; `markAnswered` marks only real ids)

## 5. Dreaming job (skill + schedule)

- [x] 5.1 `skill:dreaming` in `SEED_SKILLS` (`src/skills/seeds.ts`): procedure (digest → IDLE short-circuit → memory duties merge-don't-re-add → INDEX lint → per-thread compact at the nearest conversational seam at/earlier than the suggested boundary (completed topic/exchange or lull, always after an assistant turn) → advance → one-line final), summary contract (incl. attachments+paths, DELIVERY FAILURE verbatim, describe-never-transcribe), rules not examples
- [x] 5.2 `ensureConsolidationSchedule` → `ensureDreamSchedule` (`src/scheduler/index.ts`): idempotent on `label='dreaming'`, deletes legacy `nightly-consolidation`, cron `'30 */4 * * *'`, silent, authority `['memory_read','memory_write','bash','file_read']`, skill-pointing prompt; update runtime seeding call + scheduler unit tests
- [x] 5.3 Workflow test: scripted scheduled run with bash grants executes the CLI (craft-style shape); idle path records the run

## 6. Docs + specs sync

- [x] 6.1 README capability-model note (dreaming + compaction + sunny CLI paragraph); AGENTS.md pointer if warranted
- [ ] 6.2 Sync delta specs to main specs on archive (`/opsx:sync` or archive flow)

## 7. Verification + ship

- [x] 7.1 Full unit + integration + workflow suites; `npm run format`; `tsc --noEmit`
- [x] 7.2 Local production build (`NITRO_VITE=1 node node_modules/vite/bin/vite.js build --config vite.config.unified.ts`) — build is NOT in CI
- [ ] 7.3 PR → CI → merge → devbox restart (migration 0012 auto-applies) → verify boot
- [ ] 7.4 Post-deploy: commit live `skill:dreaming` to the authored skills repo; bump the dreaming schedule's `next_run_at` to fire now; verify `schedule_runs` output, `thread_compactions` rows, INDEX hooks, `dream_state`
- [ ] 7.5 Drive a real turn on the owner thread; compare per-step input tokens vs the ~350–400k baseline (turn metadata/Langfuse); verify recall snippets, `recall_expand`, and attachment-path rendering via the loopback channel; update `~/.claude` memory notes
