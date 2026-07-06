# Design — coding-agent-upgrade

## Context

Sunny's host capability is deliberately thin: a `bash` tool (fresh shell per call, 60s default
timeout, 30k-char output clip) and a `file_read` tool (100KB byte cap, no offset, no line
numbers), per the tool-access posture "capabilities are CLIs/skills over bash, not dedicated
tools". That posture works for email/browse/devbox, but for coding the *file mutation
primitives themselves* are the bottleneck: every edit is a bash heredoc or sed invocation —
quoting/escaping failures, whole-file rewrites, no way to anchor a surgical change — and
`file_read`'s unnumbered byte-capped output gives the model nothing to anchor an edit against.
Every proven coding harness (Claude Code, opencode, pi) converges on the same three primitives:
windowed line-numbered read, whole-file write, exact-string edit.

Existing patterns this change follows:

- **Node-free specs + step-wrapped execute** (`bashSpecs.ts`, `memorySpecs.ts`): tool
  description + zod `inputSchema` live in a module with no Node imports so WDK
  workflow/orchestrator code can import it inside the sandbox; the `execute` logic that touches
  the host lives beside `bash.ts` and is invoked from `'use step'` units in
  `workflows/job.ts`/`subagent.ts`, and directly in `conversation.ts`'s `buildTools`.
- **Catalog mirror** (`src/agent/tools/catalog.ts`): tools registered on the turn must appear in
  the dashboard catalog's `ownerOnly` grouping (built from the same factories).
- **Seed skills fill gaps only** (`src/skills/index.ts` `initSkills`): a bundled seed is written
  to `~/.sunny/skills/authored/skills/<name>/` only **if absent**; the canonical authored-skills
  repo wins. A *new* seed (coding) self-installs on live hosts; an *edited* seed (delegation)
  does not propagate — it needs a commit to the live authored repo.

## Goals / Non-Goals

**Goals:**

- Reliable, token-efficient file mutation: `file_write` (create/overwrite) and `file_edit`
  (unique exact-string replace) as native thin tools on every host-tool surface (trusted-DM
  turn, background/scheduled jobs with host tools, `host`-toolset children).
- Code-shaped reading: `file_read` gains 1-based line `offset`/`limit` windowing and
  line-numbered output, so edits anchor precisely and big files are read in windows.
- A seeded `coding` skill that encodes the workflow (search → read → edit → verify → report)
  over the existing host CLIs (`rg`, `git`, `gh`, `tmux`, `devbox`, `jq`, `fd`).
- Delegation guidance that channels long coding work into ONE child owning the whole task,
  instead of holding the interactive thread or splitting coupled edits.

**Non-Goals:**

- No external coding-CLI delegation lane (coding stays in Sunny — explicitly excluded).
- No dedicated grep/glob/todo/plan tools; `rg` via bash plus skill guidance suffices.
- No sandbox, command permissioning, or approval tiers — that is `security-permissions`;
  file writes ride the same trust gate bash already has (trusted-DM / host toolset only).
- No read-before-edit state tracking (see Decisions).
- No background-process *tool*; the coding skill teaches `nohup`/`tmux` patterns around bash's
  timeout instead.

## Decisions

### D1 — `file_write` + `file_edit` are thin tools, not a skill over bash

The tool-access principle says capabilities are skills over bash; write/edit are not a
*capability*, they are mutation *primitives* at the same altitude as `file_read` — the spec's
"core thin tools" set grows to bash + read/write/edit. A skill teaching better heredocs was
considered and rejected: quoting failure is structural (the model must embed arbitrary file
content inside a shell string), not a knowledge gap. The tool-access delta spec amends the
requirement accordingly.

### D2 — `file_edit` semantics: unique exact match, model-recoverable errors

`file_edit(path, old_string, new_string, replace_all?)`:

- `old_string` must match the file contents exactly (whitespace included). Zero matches →
  error naming the file and echoing a short prefix of the needle; >1 matches without
  `replace_all` → error stating the count. Errors are strings designed for the model to
  recover (re-read the window, widen the anchor), mirroring how `bash` reports failures.
- `replace_all: true` replaces every occurrence (rename-style edits).
- `old_string === new_string` → error (no-op guard).
- Same binary/NUL guard as `file_read` (refuse to edit binary), and the write is
  atomic-enough (write temp + rename not required on a single-user host; a plain
  `writeFileSync` is acceptable — decision: keep it simple).

**No read-before-edit enforcement.** Claude Code enforces "must Read before Edit" with
harness-side per-session file state; Sunny's turns are durable, resumable step sequences where
tracking cross-step tool state adds real machinery for modest benefit on a single-user host.
The uniqueness check catches most stale-anchor cases; the coding skill instructs "read the
window right before you edit". Revisit if stale edits show up in practice.

### D3 — `file_read` output becomes line-numbered `cat -n` style, with `offset`/`limit`

- New optional `offset` (1-based first line) and `limit` (line count, default 2000) params;
  `max_bytes` stays as a backstop cap. Long individual lines are clipped.
- Output is **always** line-numbered (one format, no mode flag the model must remember; the
  numbers are what make `file_edit` anchors and windowed re-reads reliable). Truncation notes
  say how to continue (`offset: <next-line>`).
- Considered: numbering only when windowed. Rejected — two output formats for one tool, and
  the model benefits from anchors on full reads too. Risk of numbers leaking into
  `file_write` content is mitigated in the tool description ("line numbers are display-only —
  never include them in file content") and has strong precedent (Claude Code numbers all
  reads).
- Consumers that read prose (SKILL.md bodies, memory topics via their own tools) tolerate
  numbering; memory tools have their own read path and are unaffected.

### D4 — Registration surfaces and the WDK seam

New Node-free `src/agent/tools/fileSpecs.ts` exports `FILE_TOOL_SPECS` (`file_write`,
`file_edit`) and the upgraded `file_read` spec moves there too (or stays in `bashSpecs.ts` —
implementer's choice, but specs stay Node-free and single-sourced). Host-touching logic
(`writeFileSafe`, `editFileSafe`, upgraded `readFileSafe`) lives beside `bash.ts`. Wiring:

- `workflows/conversation.ts` `buildTools` — trusted-DM turn (alongside bash/file_read).
- `workflows/job.ts` — host-tools jobs, via `'use step'` wrappers (new `fileWriteStep`,
  `fileEditStep` mirroring `bashStep`/`fileReadStep`, likely in `workflows/runShell.ts`).
- `workflows/subagent.ts` `buildChildTools` — the `host` preset grows to bash + read/write/edit
  (still strictly a subset of the parent; the `readonly` and `none` presets are unchanged, so
  least-privilege containment is unaffected).
- `src/agent/tools/catalog.ts` — the ownerOnly mirror picks the new tools up via the same
  factory.

### D5 — `coding` seed skill (content), delegation skill wording (repo commit)

The `coding` skill is a new `SEED_SKILLS` entry (template literal, no backticks) covering:
read the target repo's AGENTS.md/CLAUDE.md/README first; search with `rg -n`; read before
editing; prefer `file_edit`/`file_write` over heredocs/sed; small verified steps (typecheck/
tests after each meaningful change); git hygiene (branch first, real commit messages, never
force-push, never commit unless asked); long-running processes via `nohup … > log 2>&1 &` +
tail-polling or `tmux` (bash calls time out; servers go through devbox); iMessage-appropriate
reporting (what changed + diffstat/link, no code walls). It self-installs on live hosts (new
seed fills the gap).

The delegation seed's §1 wording is softened in `seeds.ts`: splitting *coupled* edits across
children still fails; **one child owning a whole coding task end-to-end is a good shape** (and
now the `host` toolset can actually edit). Because edited seeds don't propagate, deployment
includes committing the updated delegation SKILL.md to the live canonical authored repo.

### D6 — Prompt touch is job-prompt-only

`buildJobPrompt`'s hostTools block adds one static line for the file tools. The interactive
system prompt doesn't enumerate host tools today and stays untouched (byte-stable prefix /
cache invariant D-PS4). `buildSubagentPrompt` already says "your tools are limited to what the
task needs" — unchanged.

### D7 — `jq` + `fd` are host setup, not code

Installed via apt on the host; documented in README's setup section. The coding skill may
reference both.

## Risks / Trade-offs

- [Stale anchor: file changed between read and edit] → uniqueness check + skill guidance to
  re-read the window immediately before editing; no state tracking (D2). Revisit on evidence.
- [Line numbers copied into written content] → explicit "display-only" warning in both
  `file_read` and `file_write` descriptions; strong precedent that models handle this.
- [Heredoc habit persists despite new tools] → `bash` description gains a pointer ("for file
  creation/editing prefer file_write/file_edit"); coding skill reinforces.
- [Seed-edit propagation gap: live delegation skill keeps old wording] → explicit deploy task:
  commit the updated SKILL.md to the canonical authored repo (seeds only fill gaps).
- [Host-toolset children can now mutate files] → identical consequence surface to the bash they
  already hold (bash can already write anywhere); least-privilege presets unchanged;
  `security-permissions` remains the enforcement change.
- [file_read format change surprises existing flows (skills read via file_read)] → numbering is
  additive noise, not information loss; verified consumers are model-facing only.

## Migration Plan

No DB or config changes. Ship = merge → restart the `sunny` devbox service (HMR can serve
stale code) → verify the new tools appear in the dashboard tool catalog → commit the updated
delegation SKILL.md to the canonical authored repo (the coding skill seeds itself) → `apt
install jq fd-find` on the host. Rollback = revert the merge and restart; seeds/skills are
plain files and harmless to leave.

## Open Questions

- None blocking. (Whether `file_read`'s upgraded spec lives in `bashSpecs.ts` or moves to
  `fileSpecs.ts` is an implementer's call — keep it single-sourced and Node-free.)
