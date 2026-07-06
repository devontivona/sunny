# Tasks — coding-agent-upgrade

## 1. File tool specs + host logic

- [x] 1.1 Create Node-free `src/agent/tools/fileSpecs.ts` with `FILE_TOOL_SPECS` for
      `file_write` (path, content) and `file_edit` (path, old_string, new_string,
      replace_all?) — descriptions per design D2 (unique-match rule, "line numbers are
      display-only" warning), zod schemas, no Node imports (mirror `bashSpecs.ts`)
- [x] 1.2 Upgrade the `file_read` spec: optional 1-based `offset` + `limit` (default 2000
      lines) params, description documents line-numbered output and how to continue reading;
      keep `max_bytes` as backstop (single-sourced, Node-free — in `fileSpecs.ts` or
      `bashSpecs.ts`)
- [x] 1.3 Implement host logic beside `bash.ts`: `writeFileSafe` (mkdir -p parents, UTF-8
      write), `editFileSafe` (exact match; 0-match and >1-match errors with counts; no-op
      guard; binary/NUL refusal), upgraded `readFileSafe` (line windowing, `cat -n`-style
      numbering, long-line clipping, continuation note on truncation)
- [x] 1.4 Add a pointer to the `bash` tool description: prefer `file_write`/`file_edit` over
      heredocs/sed for file creation and editing
- [x] 1.5 Unit tests for write/edit/read logic: unique-match enforcement, replace_all,
      zero/multi-match errors, binary refusal, parent-dir creation, windowing + numbering +
      truncation notes

## 2. Registration on every host-tool surface

- [x] 2.1 Register `file_write`/`file_edit` (and the upgraded `file_read`) in
      `workflows/conversation.ts` `buildTools` alongside bash (trusted-DM gate)
- [x] 2.2 Add `'use step'` wrappers (`fileWriteStep`, `fileEditStep`, mirroring
      `bashStep`/`fileReadStep`) and register the tools in `workflows/job.ts` host-tools jobs
- [x] 2.3 Grow the `host` toolset in `workflows/subagent.ts` `buildChildTools` to bash +
      read/write/edit; leave `readonly`/`none`/`memory` presets unchanged
- [x] 2.4 Mirror the new tools in `src/agent/tools/catalog.ts` (ownerOnly group) and update
      its unit test
- [x] 2.5 Add the file-tools line to `buildJobPrompt`'s hostTools block in
      `src/agent/prompt.ts` (static text only; interactive prompt untouched — D-PS4)

## 3. Skills

- [x] 3.1 Add the `coding` seed skill to `src/skills/seeds.ts` (template literal, no
      backticks): orient on AGENTS.md/CLAUDE.md/README → search with `rg -n` → read before
      editing → `file_edit`/`file_write` over heredocs → verify (typecheck/tests) after each
      meaningful change → git hygiene (branch first, real messages, never force-push, commit
      only when asked) → long-running processes via `nohup`/`tmux` around the bash timeout,
      serve via devbox → iMessage-appropriate reporting (summary + diffstat/link, no code
      walls); mention `jq`/`fd` availability
- [x] 3.2 Update the delegation seed's §1 wording in `seeds.ts`: splitting coupled edits
      across children still fails, but ONE child owning a whole coding task end-to-end is a
      good shape (host toolset can now edit)
- [x] 3.3 Update `src/skills/skills.unit.test.ts` if it asserts the seed set

## 4. Verification + deploy

- [x] 4.1 Run typecheck, unit tests, and the eval-safe test suites; fix fallout
- [x] 4.2 End-to-end check on the dev host: a trusted-DM turn creates a file with
      `file_write`, edits it with `file_edit` (including a deliberate multi-match failure and
      recovery), reads it back windowed; dashboard tool catalog lists the new tools
- [x] 4.3 Install `jq` and `fd` on the host (`apt install jq fd-find`) and add a setup note to
      the README host-deps section
- [x] 4.4 Deploy: merge → restart the `sunny` devbox service → commit the updated delegation
      SKILL.md to the live canonical authored-skills repo (edited seeds don't propagate;
      the new coding skill seeds itself on restart)
