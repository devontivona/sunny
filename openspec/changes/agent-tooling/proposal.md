## Why

Sunny today has only thin/placeholder tools, a skills *vision* but no skill runtime, and no way to use Devon's credentials. Before a security/permissions layer is worth building, Sunny needs the actual **capabilities** — the tools and skills, and the 1Password plumbing that lets them authenticate — built and tested. Building the capability layer first lets us exercise the tools thoroughly, then layer consequence-gating on top as a clean wrapper rather than designing approval flows against tools that don't exist yet.

This change delivers that capability layer. The companion **security-permissions** change layers gating, approval, taint-tracking, and credential hardening on top of it. The in-between (ungated) state is for **attended testing only**, never autonomous/production use.

## What Changes

Deliver Sunny's capability layer in one change:

- **agent-skills** — `SKILL.md` loader (agentskills.io format) from `~/.sunny/skills/`, progressive disclosure, self-authoring (`skill_manage`, auto+notify), gated installs via `npx skills`, validation, and seeded known-good skills (skill-authoring, skill-discovery/installation, `devbox`).
- **tool-access (contract + tools)** — a uniform **tool-registration contract** (each tool declares risk tier + `op://` references — *recorded, not yet enforced*); core thin tools (`bash`, `file-read`, `web-fetch`); per-command `op run` credential injection; a **credentialed browse capability** (default engine: Vercel `agent-browser` — token-efficient, durable on-disk sessions, built-in encrypted auth vault, CLI-fits-bash; 1Password seeds the session, value never reaches the model; plus an ephemeral research mode; per-site knowledge as engine-agnostic SKILL.md skills from the browse.sh catalog + self-authored); and capabilities-as-skills (**email** over himalaya, **website-builder**).
- **credentials (plumbing)** — dedicated read-only `Sunny` 1Password vault + Service Account; the model only ever handles `op://` references, never values; per-tool reference whitelist.
- **web-dashboard (delta)** — read-only **Tools** and **Skills** directories.

**Deliberately deferred to `security-permissions`:** approval tiers + smart triage, command-permissioning (AST policy), skill-scoped allowlists, taint-tracking + step-up auth, the hard blocklist, credential token hardening + rotation, crypto DM-pairing, and audit gating. The *declarations* this change records are what that change enforces.

## Capabilities

### New Capabilities
- **agent-skills** — self-installable/-authorable `SKILL.md` skills with progressive disclosure.
- **tool-access** — the uniform tool-registration contract plus the concrete tool/skill catalog (enforcement deferred to `security-permissions`).
- **credentials** — 1Password Service Account resolution plumbing; secrets resolved in the tool layer, never exposed to the model (hardening/rotation deferred to `security-permissions`).

### Modified Capabilities
- **web-dashboard** — add read-only Tools and Skills directories.

## Impact

Builds on `messaging-gateway`, `durable-execution`, `scheduling`, and `web-dashboard`. **Blocks / is required by `security-permissions`** (which enforces the declarations recorded here). Pairs with `subagents` (route untrusted content to a no-credential child) and `observability` (audit log the dashboard directories can grow into). Browser engine decision: **Vercel `agent-browser`** (default — local, owner's session state stays on the host; token-efficient; durable sessions; built-in auth vault) with **Playwright/Stagehand as the fallback** for deterministic scripted flows and Browserbase cloud as an optional escalation for un-credentialed research only.
