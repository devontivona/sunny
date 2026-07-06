# Coding-agent upgrade

## Why

Sunny already handles casual coding tasks well through `bash`, but every file edit goes through
shell heredocs/sed — quoting landmines, whole-file rewrites that burn tokens, and no
read-before-edit discipline — and nothing teaches Sunny a coding workflow. Adding the two file
primitives every proven coding harness is built on (write + exact-string edit), a code-shaped
`file_read`, and a seeded coding skill closes most of the gap to a capable casual coding agent
while keeping the thin-tool posture. (An external coding-CLI delegation lane was considered and
deliberately excluded — coding stays in Sunny.)

## What Changes

- **New `file_write` tool** — create or overwrite a UTF-8 text file (mkdir -p semantics for the
  parent directory), registered wherever host tools are (owner/family DMs, jobs, host-toolset
  children).
- **New `file_edit` tool** — exact-string replacement in an existing file; fails unless the
  `old_string` match is unique (or `replace_all` is set), so edits are surgical and verifiable.
- **`file_read` becomes code-shaped** — optional line `offset`/`limit` windowing and
  line-numbered output (`cat -n` style), so the model can anchor edits precisely and read big
  source files in windows instead of hitting a byte cap.
- **New `coding` seed skill** — the coding workflow: read the repo's AGENTS.md/CLAUDE.md first,
  search with `rg`, read before editing, edit with `file_edit` (not heredocs), verify with the
  project's tests/typecheck, git hygiene, background long-running processes (`nohup`/`tmux`)
  around bash's timeout, serve via devbox, and iMessage-appropriate reporting (diffstat/links,
  not code dumps).
- **Delegation `host` toolset gains the file tools** — a child endowed with host tools gets
  `file_write`/`file_edit` too (still a subset of the parent); the delegation seed skill's
  guidance is updated: don't split coupled edits across children, but one child owning a whole
  coding task end-to-end is a good shape.
- **Prompt touch** — the job prompt's host-tools block mentions the file tools alongside
  bash/file_read (cache-stable: static text, no per-run data).
- **Host deps** — `jq` and `fd` installed on the host (setup doc note); the coding skill may
  reference them.

## Capabilities

### New Capabilities

(none — everything lands in existing capabilities)

### Modified Capabilities

- `tool-access`: the "Core thin tools" requirement grows from bash + file-read to bash +
  file-read/write/edit — write/edit become part of the minimal thin-tool surface, and file-read
  gains line-windowed, line-numbered reading.
- `agent-skills`: the seeded-skills requirement adds a seeded `coding` skill to the shipped set.

## Impact

- **Code**: `src/agent/tools/` (new `fileEditSpecs.ts` + execute logic, `bashSpecs.ts`/`bash.ts`
  for the file_read upgrade, `catalog.ts`), `workflows/conversation.ts` (buildTools),
  `workflows/job.ts` + `workflows/subagent.ts` (host toolsets), `src/agent/prompt.ts` (job
  host-tools block), `src/skills/seeds.ts` (+ delegation skill wording, new coding skill).
- **Specs**: `tool-access`, `agent-skills` deltas.
- **Security**: file writes/edits are host mutations exactly like bash already is — same trust
  gate (trusted-DM / host-toolset children only), no new credential surface. Command
  permissioning still arrives separately with `security-permissions`.
- **Docs/host**: README/setup note for `jq`/`fd`.
