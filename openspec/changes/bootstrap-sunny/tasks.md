> Build plan for bootstrap-sunny. Phases are ordered so each builds on a working
> predecessor; a "walking skeleton" (Phase 1) is reachable early, then capabilities
> layer on. Each group references its spec under `specs/<capability>/` and the
> design decisions (D-*) in `design.md`.

## 1. Phase 0 — Foundation & infrastructure

- [ ] 1.1 Scaffold the Node LTS + TypeScript project (D-PS1): `package.json`, `tsconfig`, the `src/` layout (D-PS2), lint/format, env loading.
- [ ] 1.2 Stand up Postgres locally and wire Drizzle (schema + migrations harness) (D-PS1, D-DE4).
- [ ] 1.3 Install/pin core deps: `ai` (v6), `@ai-sdk/anthropic`, `chat`, `@workflow/world-postgres`, `@1password/sdk`, Drizzle, an OTel SDK. Pin `@1password/sdk` (0.x).
- [ ] 1.4 Create the `~/.sunny/` runtime contract: `memory/` + `skills/` under a **single git repo at `~/.sunny/`** (not nested per-subdir repos); config file loader (non-secret settings) (D-PS5).
- [ ] 1.5 Wire the model: `anthropic('claude-opus-4-8')`, adaptive thinking + effort defaults, `ANTHROPIC_API_KEY` from env (D-PS3).
- [ ] 1.6 1Password setup: create the dedicated read-only `Sunny` vault + Service Account; load `OP_SERVICE_ACCOUNT_TOKEN` from a hardened `EnvironmentFile`; SDK wrapper that resolves `op://` refs in the tool layer only (D-CR1, D-CR2, D-CR4).
- [ ] 1.7 systemd unit for the `sunny` service (`Restart=always`) + Postgres service; document the deploy (D-PS6).

## 2. Phase 1 — Walking skeleton (gateway ↔ agent ↔ Opus over iMessage)

- [ ] 2.1 Define the normalized `Gateway` seam: `ChannelEvent` inbound, `send()` outbound, `capabilities` (messaging-gateway R: normalized interface, D-MG1/3).
- [ ] 2.2 Implement the iMessage driver via Chat SDK + Photon adapter on Spectrum Cloud; HTTP webhook listener for inbound (D-MG1, D-MG7).
- [ ] 2.3 Own the conversation store: persist every inbound/outbound message to Postgres (messages table) (messaging-gateway R: self-owned store, D-MG2).
- [ ] 2.4 Sender authorization: allowlist Devon's identity at the gateway (messaging-gateway R: sender authorization, D-MG6).
- [ ] 2.5 Minimal agent loop (`ToolLoopAgent`) that reads recent messages from the store, calls Opus, persists + sends a reply. **Milestone: text Sunny, get a reply.**
- [ ] 2.6 Per-channel capability flags + graceful degradation; no token streaming (complete messages) (D-MG3, D-DE3).

## 3. Phase 2 — Memory

- [ ] 3.1 Always-on core: load `USER.md` + `SUNNY.md` + `INDEX.md` each run; render as a byte-stable cached system prefix (agent-memory R: always-on core; D-PS4 caching).
- [ ] 3.2 Memory write tool (`add`/`replace`/`remove`, no `read`); error-on-overflow forces consolidation (agent-memory R: forced consolidation, D2).
- [ ] 3.3 On-demand topic docs via `INDEX.md` router; date-tagged facts for temporal reasoning (agent-memory R: topic docs, date-tagged facts; D1, D4).
- [ ] 3.4 Keyword recall: Postgres `tsvector`/GIN FTS over messages + LLM summarization; rolling recent-window + recall for older (agent-memory R: keyword recall; D-OB? n/a).
- [ ] 3.5 Memory-vs-skill boundary in agent instructions; verify caching with `cache_read_input_tokens > 0` (D-PS4).
- [ ] 3.6 (Deferred-ready) define the recall interface so `pgvector` semantic search slots in later without agent-loop changes (agent-memory R: semantic upgrade path, D5).
- [ ] 3.7 Cold-start/onboarding: hand-seed a starter `USER.md`; onboarding conversation that records durable facts; memory global to Devon, message window per thread (R11).
- [ ] 3.8 Serialize all memory-file mutations through a single writer / advisory lock; reads snapshot-at-run-start (R7).
- [ ] 3.9 Enable prompt caching only on multi-step turns / bursts (cache write ≈1.25×); verify `cache_read_input_tokens > 0`; do not assume the always-on core is free (R2, D-PS4).

## 4. Phase 3 — Durable execution & scheduling

- [ ] 4.1 Idempotent conversational turns keyed by message id; re-process un-answered messages on restart; inbound dedup; **serialize turns per thread** (durable-execution R: idempotent turns, D-DE1; R7).
- [ ] 4.1b Double-text steering: per-thread **steer-buffer** drained by AI SDK `prepareStep` so a new owner message folds into the in-flight run at the next step (not a new run, not a kill); `abortSignal` restart only when the message invalidates the task (durable-execution R: double-text steering; R12).
- [ ] 4.2 WDK on `@workflow/world-postgres`; `start_job` tool that promotes long/async work to a durable Tier-2 job; side effects in `'use step'` (durable-execution R: durable jobs; D-DE1/2).
- [ ] 4.3 Single-write persistence on completion; completion notification via gateway (durable-execution R: single-write, completion notification; D-DE3).
- [ ] 4.4 Scheduler: persisted schedules in Postgres (relative/absolute one-shot, interval, cron) from natural language; dispatch as Tier-2 jobs; WDK `sleep()` for one-shots (scheduling R: schedule types, durable schedules; D-SC1/2).
- [ ] 4.5 Self-scheduling tool + anti-recursion guard (scheduled runs can't create schedules) (scheduling R: self-scheduling, anti-recursion; D-SC3/4).
- [ ] 4.6 Scheduled output delivery + run history; missed-fire policy (one-shots catch up once; recurring no backfill) (scheduling R: output delivery; D-SC5).
- [ ] 4.7 Wire the nightly memory-consolidation job as the first recurring schedule (agent-memory D3 × scheduling).

## 5. Phase 4 — Security, tools & credentials

- [ ] 5.1 Approval tiers: smart risk-assessor on a **cheap fast model (Haiku-class)** + hard-gated categories (money / destructive / act-as-Devon); approvals **durable-suspended** (WDK hook) with an **id-correlated** reply, re-prompt on ambiguity, default-deny on timeout (security R: approval tiers, durable/correlated approvals; D-SEC3; R9, R10).
- [ ] 5.1a Owner tagging end-to-end: gateway tags `isOwner`; non-owner group messages are answerable but cannot trigger consequence or approve (security R: identity; messaging-gateway R: owner tagging; R1).
- [ ] 5.2 Hard blocklist (rm -rf /, fork bombs, reading the op token file, weakening own guards) (security R: hard blocklist; D-SEC4).
- [ ] 5.3 Command-permissioning (bash-centric, R13): deny-by-default allow/ask/deny policy matched on a **parsed command AST** (enumerate sub-commands across pipes/`$()`/chains; fail-closed); **skill-scoped command allowlists**; smart-mode triages the uncertain middle; per-command `op run` credential injection (`op://` → that subprocess's env only) (tool-access R: command permissioning, skill-scoped perms, per-command injection; D-TA1).
- [ ] 5.3b Taint-tracking + step-up auth (R14): mark whether a run's context contains untrusted content; **clean** commands run under the normal policy with full host access; **tainted** commands require **step-up "2FA"** (provenance-flagged confirmation + a real second factor — TOTP/passkey/out-of-band tap); **unattended** tainted commands block + defer to Devon (or targeted sandbox); **restrict egress** as a backstop regardless (tool-access R: taint-tracking + step-up; R14).
- [ ] 5.4 Thin tools (bash, file read, web fetch) + capabilities as skills: **`devbox` skill** for build/run/host sites (public deploy = ask/blocked command); **email skill** over himalaya for `sunny@waywardlane.com` (CC/forward to act; himalaya *send* hard-gated; bodies untrusted → injection-contained, ideally a no-credential subagent); research/todos as skills (R3, R5, R13).
- [ ] 5.5 Credentialed browser tool in an isolated profile with a **persistent logged-in profile** (cookie store treated as a credential surface — on the hard blocklist, never logged/read by other tools); fill logins from whitelisted refs at fill-time; credentialed actions approval-gated (security D-SEC4/5, tool-access R: browser routing, D-TA3; R6).
- [ ] 5.6 Prompt-injection containment: untrusted content treated as data, delimited, not followed (security R: untrusted-content-is-data; D-SEC6).
- [ ] 5.7 Crypto DM-pairing for identity (upgrade the Phase-1 allowlist) (security R: command identity; D-SEC2).

## 6. Phase 5 — Skills

- [ ] 6.1 `SKILL.md` loader (agentskills.io format) from `~/.sunny/skills/`; progressive disclosure (metadata index on the cached prefix, body on trigger) (agent-skills R: format, loading; D-SK1/2).
- [ ] 6.2 Self-authoring `skill_manage` tool (create/edit/delete) auto+notify; validate before activation (agent-skills R: self-authoring, validation; D-SK4/7).
- [ ] 6.3 Installed-skill path via `npx skills add owner/repo` (Vercel's installer — same tool used for `devbox`): approval-gated, reviewed, treated as untrusted; skills run under tool-access gating, `allowed-tools` only restricts (agent-skills R: installed untrusted, no escalation; D-SK5/6; R4).
- [ ] 6.4 (Deferred-ready) `pgvector` retrieval over skill descriptions when the metadata budget is exceeded (agent-skills D3).

## 7. Phase 6 — Observability

- [ ] 7.1 OpenTelemetry spans (AI SDK telemetry + WDK + gateway/tool) to a self-hosted collector; no egress (observability R: OTel; D-OB1).
- [ ] 7.2 Per-run trajectories persisted to Postgres (observability R: trajectories; D-OB2).
- [ ] 7.3 Cost/token budget meter with enforcement: per-run cap + autonomous rate limit (wires scheduling D-SC6) → stop + notify; **plus a global daily/monthly spend ceiling + kill switch and an agent-loop step cap** covering all activity (observability R: budget metering, global circuit-breaker; D-OB3; R8).
- [ ] 7.4 Redacted audit log of tool + secret access (wires security D-SEC7); redaction across all sinks (observability R: audit log, redaction; D-OB4/5).
- [ ] 7.5 Insights summary deliverable over the gateway (observability R: insights; D-OB6).

## 8. Phase 7 — Subagents

- [ ] 8.1 `delegate_task`: isolated-context child, restricted (subset) toolset, result-only return (subagents R: delegation; D-SUB1/3).
- [ ] 8.2 Bounds: concurrency cap (default 3), depth cap (default 2), no sub-delegation unless orchestrator (subagents R: bounded; D-SUB2).
- [ ] 8.3 Least-privilege enforcement + durable delegation (Tier-2) + child spans/trajectories in observability (subagents R: least-privilege, durable/observed; D-SUB3/4/6).
- [ ] 8.4 Pattern: delegate untrusted-content processing to a no-credential, no-high-consequence-tool subagent (subagents D-SUB5).

## 9. Backups & cross-cutting

- [ ] 9.1 Backups: scheduled `git` commits of the single `~/.sunny/` repo (memory + skills); periodic `pg_dump` of the local Postgres DB (off-host copy).
- [ ] 9.2 Rotate the 1Password Service Account token on a schedule (credentials D-CR4 × scheduling).
- [ ] 9.3 End-to-end smoke test of the gated paths (send-email approval, credentialed browser, blocklist refusal) before relying on autonomy.
