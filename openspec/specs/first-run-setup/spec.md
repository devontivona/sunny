# first-run-setup Specification

## Purpose
First-run setup makes a fresh machine fully operational from a repository clone plus documented environment variables: all datastore provisioning (Drizzle migrations and WDK world tables) applies idempotently at startup or via a single setup command, an `npm run doctor` preflight names every missing prerequisite with a remediation hint, and machine-agnostic defaults replace personal-host fallbacks. Where required configuration is absent, the runtime degrades loudly — warning prominently and disabling the dependent feature — rather than crashing at boot or silently skipping shipped functionality.

## Requirements

### Requirement: Complete provisioning from clone plus environment
A fresh machine SHALL be fully provisioned by: cloning the repository, providing the documented environment variables, and starting the service. All datastore provisioning — Drizzle migrations AND Workflow DevKit world tables — SHALL be applied idempotently at startup (or by a single documented `npm run setup` command); no provisioning step SHALL exist only as prose in the README.

#### Scenario: WDK world tables are provisioned without a manual step
- **WHEN** the service starts against a Postgres database that lacks the Workflow DevKit world tables
- **THEN** the world tables are created (or `npm run setup` creates them as part of the single documented setup command) before durable workflows are dispatched

#### Scenario: Provisioning is idempotent
- **WHEN** startup provisioning runs against an already-provisioned database
- **THEN** it makes no changes and does not error

### Requirement: Preflight doctor command
The project SHALL provide an `npm run doctor` command that checks, at minimum: required environment variables (`ANTHROPIC_API_KEY`, `DATABASE_URL`, `WORKFLOW_TARGET_WORLD`/`WORKFLOW_POSTGRES_URL`, Sendblue credentials, `DASHBOARD_PUBLIC_URL`), owner identity present in `~/.sunny/config.json`, required host CLIs (`rg`, `jq`, `fd`, `git`, `gh`, `tmux`), git authentication for the configured state and skills remotes, database reachability, WDK world tables present, migration currency, and `agent/builtin` present at the runtime working directory. Each check SHALL report pass/fail with a remediation hint, and the command SHALL exit non-zero if any required check fails.

#### Scenario: Doctor surfaces a missing prerequisite
- **WHEN** `npm run doctor` runs on a machine missing a required env var or host CLI
- **THEN** the failing check is named with a remediation hint and the exit code is non-zero

#### Scenario: Healthy machine passes
- **WHEN** `npm run doctor` runs on a fully configured machine
- **THEN** all checks report pass and the exit code is zero

### Requirement: Degraded startup is loud, not silent
When the runtime starts without configuration required for a shipped feature to operate (e.g. owner identity or messaging transport required by a builtin schedule), it SHALL emit a prominent startup warning naming the feature and the missing configuration. A shipped feature SHALL NOT be silently skipped.

#### Scenario: Missing schedule prerequisites warn loudly
- **WHEN** the runtime boots without the configuration a builtin schedule needs to run
- **THEN** startup logs a prominent warning naming the schedule and the missing configuration, instead of skipping it silently

### Requirement: Boot does not require messaging transport secrets
The service SHALL boot successfully when `SENDBLUE_*` secrets are absent: the messaging transport is disabled with a prominent startup warning, while the rest of the runtime (echo/test channel, dashboard, scheduler, doctor) remains usable. Missing transport secrets SHALL NOT crash the boot.

#### Scenario: Bare clone boots in echo mode
- **WHEN** the service starts with no Sendblue credentials configured
- **THEN** it boots with the transport disabled and a warning, and the echo/test channel still works

### Requirement: No personal-host fallbacks in outward URLs
Outward-facing URLs (dashboard approve links, MCP OAuth redirect URIs, media links) SHALL derive from explicit configuration (`DASHBOARD_PUBLIC_URL`/`PUBLIC_BASE_URL`). When unset, the runtime SHALL warn loudly and degrade the dependent feature; it SHALL NOT fall back to a hardcoded personal domain.

#### Scenario: Unset public URL degrades loudly
- **WHEN** `DASHBOARD_PUBLIC_URL` is unset and a feature needs an outward URL
- **THEN** a prominent warning names the feature and the missing setting, and no URL pointing at another operator's domain is emitted

### Requirement: Git persistence uses a fixed committer identity
Commits the runtime makes to the state and skills repositories SHALL set an explicit committer identity (e.g. via `-c user.name`/`-c user.email`) rather than relying on the machine's global git configuration, so state persistence works on a host with no git identity configured.

#### Scenario: Fresh host without git identity still persists state
- **WHEN** the runtime commits memory or skill changes on a machine with no global git user configured
- **THEN** the commit succeeds with the fixed runtime identity
