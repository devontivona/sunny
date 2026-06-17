> Build plan for the agent-skills change (originally Phase 5 of `bootstrap-sunny`).
> D-* decisions are in this change's `design.md`.

- [ ] 1 `SKILL.md` loader (agentskills.io format) from `~/.sunny/skills/`; progressive disclosure (metadata index on the cached prefix, body on trigger) (agent-skills R: format, loading; D-SK1/2).
- [ ] 2 Self-authoring `skill_manage` tool (create/edit/delete) auto+notify; validate before activation (agent-skills R: self-authoring, validation; D-SK4/7).
- [ ] 3 Installed-skill path via `npx skills add owner/repo` (Vercel's installer — same tool used for `devbox`): approval-gated, reviewed, treated as untrusted; skills run under tool-access gating, `allowed-tools` only restricts (agent-skills R: installed untrusted, no escalation; D-SK5/6; R4).
- [ ] 4 (Deferred-ready) `pgvector` retrieval over skill descriptions when the metadata budget is exceeded (agent-skills D3).
