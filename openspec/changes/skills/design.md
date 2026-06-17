# Design — Agent Skills

> Carved out of the `bootstrap-sunny` change (originally Phase 5).

# Agent Skills

## Context (agent-skills)

A central part of Sunny's vision is that it can **install, write, and learn its own skills** — modular, file-based units of procedure that teach it how to do things. Research established that the `agentskills.io` `SKILL.md` format is a real, multi-vendor open standard (Claude Code, Cursor, Hermes, OpenClaw, the Vercel skills already in this repo), with progressive disclosure for context efficiency and shipping prior art for runtime self-authoring (Anthropic's skill-creator).

**Install sources — `skills.sh` is a discovery index, not the substrate.** Because the format is just a `SKILL.md` in a Git repo and `npx skills add owner/repo` installs from *any* Git source (GitHub/GitLab shorthand, full URLs, per-skill paths, local dirs), the real "registry" is **Git + the format**. `skills.sh` is a zero-curation popularity index over those same repos — useful for discovery, not a separate integration. Other notable sources: Anthropic's curated **`anthropics/skills`** and **`vercel-labs/agent-skills`** repos; per-agent registries like OpenClaw's **ClawHub** and Hermes' **Skills Hub** (both convenience indexes over the same git+format substrate); and "awesome-skills" community lists. Sibling projects worth tracking: **OpenClaw** (`openclaw/openclaw`) is a local-first personal AI assistant — also multi-channel incl. iMessage, also `SKILL.md`-based — i.e. the closest existing thing to Sunny; and **Hermes** uses `SKILL.md` under `~/.hermes/skills/`. So skills are broadly portable, with caveats (tool-name assumptions, `allowed-tools` is experimental, OS/`metadata` gating is agent-specific).

Because any of these resolve to untrusted third-party code, installed skills must be treated as untrusted (D-SK5).

## Goals / Non-Goals (agent-skills)

**Goals:**
- Standard, portable, self-authorable skills (`SKILL.md`), stored as git-able files.
- Context-efficient discovery that scales as the library grows.
- Sunny authoring its own skills with low friction (auto + notify), and installing external skills safely (gated, reviewed).
- Skills that cannot escalate privilege — their actions are gated like any tool use.

**Non-Goals:**
- A bespoke skill format (adopt the open standard).
- Sandboxing skill execution (per security D-SEC5, skills run direct; installation is the gated event).
- A full automated skill-eval/benchmark loop now (a possible later enhancement).

## Decisions (agent-skills)

### D-SK1 — Adopt the `SKILL.md` open standard, files-first

Skills follow `agentskills.io`: a `skills/<name>/SKILL.md` (YAML frontmatter — `name`, `description` required; optional `license`, `compatibility`, `metadata.version`, `allowed-tools`) plus optional `scripts/`, `references/`, `assets/`. Stored under `~/.sunny/skills/`, git-able like the memory soul. This makes skills portable across agents and installable from `skills.sh`.

### D-SK2 — Progressive-disclosure loading, on a shared always-on budget

Only skill `name` + `description` are always in context (an index); the body loads when a task matches; `references/`/`scripts/` load/execute on demand (script code never enters context — only its output). The metadata index is budget-capped (drop least-used descriptions first, names retained) and shares the always-on token budget defined in `agent-memory`.

### D-SK3 — Discovery scales via pgvector retrieval

When the library outgrows the metadata budget, candidate skills are pre-selected by embedding their descriptions and retrieving the nearest matches — reusing the same local-embeddings + `pgvector` infrastructure introduced for memory L3. No new datastore.

### D-SK4 — Self-authoring loop (auto + notify)

A `skill_manage` tool lets Sunny create / edit / delete its own skills. The loop: reflect on a completed task → write a `SKILL.md` with a deliberately pushy, keyword-rich description → validate → save → auto-discovered next run. Triggers (from Hermes/skill-creator): completing a gnarly multi-step task, recovering from an error/dead-end, a user correction, or discovering a reusable workflow. The memory-vs-skill boundary (`agent-memory`): durable *fact* → memory, durable *procedure* → skill.

Self-authored skills are created **automatically and the user is notified** (e.g. "wrote a skill: deploy-tivona-site"); they are immediately usable. The user can review/edit/delete the file at any time (git history makes this safe). This mirrors the co-authored memory posture (D6).

### D-SK5 — Two trust tiers: self-authored (trusted) vs installed (untrusted)

- **Self-authored** skills are trusted (Sunny wrote them under its own guardrails) → auto + notify (D-SK4).
- **Installed** skills (from **any agentskills-compatible Git source** via `npx skills add owner/repo` — which covers the skills.sh index, `anthropics/skills`, `vercel-labs/agent-skills`, and arbitrary repos) are **untrusted code** → installation is an APPROVAL-gated action (security D-SEC3/D-SEC5), validated (D-SK7) and reviewed before enable. They run directly (not sandboxed), so the protection is install-time gating + review + execution-time gating (D-SK6). We don't integrate any proprietary registry protocol — "install from any Git source containing a `SKILL.md`" is the single primitive; ship `anthropics/skills` + `vercel-labs/agent-skills` (and your own `devbox`) as seeded known-good defaults.

### D-SK6 — Skills cannot escalate privilege

A skill body is instructions; when it runs scripts or invokes tools, those pass through normal tool-access gating (D-TA1), the approval tiers (D-SEC3), and the hard blocklist (D-SEC4). A skill's optional `allowed-tools` frontmatter may *further restrict* (never expand) what it can use. So even a malicious installed skill cannot bypass the consequence-gating floor.

### D-SK7 — Validation before activation

Skills are validated against the `SKILL.md` schema (e.g. the agentskills reference validator) on creation/installation; an invalid skill is not activated.

### Rejected alternatives (agent-skills)

- **Bespoke/proprietary skill format:** loses portability and the `skills.sh` ecosystem; rejected for the open standard.
- **Trust installed skills like self-authored ones:** ignores that `skills.sh` is zero-curation with bypassable scanning; rejected — installs are gated and reviewed.
- **Review-gate self-authored skills:** rejected per Devon's choice (auto + notify) for low friction; the file is reviewable/reversible anyway.
- **Embedding-retrieval from day one:** unnecessary at small library sizes; the metadata index suffices until it doesn't (D-SK3).

## Risks / Trade-offs (agent-skills)

- **Installed skills run with full host access (untrusted code):** mitigated by approval-gated installs, review-before-enable, `allowed-tools` restriction, and execution-time gating (D-SK6). Sandboxing remains a future option if registry installs become common.
- **Self-authored skill sprawl / low quality:** auto-creation may accumulate weak skills. Mitigated by notification + reviewability, least-used eviction from the index (D-SK2), and (later) an eval loop.
- **Always-on budget pressure:** many skills compete with memory for always-on context. Mitigated by budget caps and pgvector retrieval (D-SK2/3).
- **Description quality drives discovery:** under-triggering if descriptions are weak; mitigated by the "pushy, keyword-rich description" authoring heuristic (D-SK4).

---

