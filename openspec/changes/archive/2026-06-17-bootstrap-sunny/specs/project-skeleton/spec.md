## ADDED Requirements

### Requirement: Self-hosted Node + TypeScript runtime
Sunny SHALL run as a self-hosted Node LTS + TypeScript application. All database-backed state SHALL be accessed through Drizzle, and schema migrations SHALL be applied automatically at startup before the service handles messages.

#### Scenario: Migrations apply on boot
- **WHEN** the service starts
- **THEN** any pending database migrations are applied before it begins handling messages

### Requirement: Repo and runtime-state separation
Application code SHALL live in the project repository; mutable runtime state SHALL live under `~/.sunny/` — the memory soul and skills as a single git-able repository — with Postgres as a separate datastore. Runtime state SHALL NOT be stored inside the code repository.

#### Scenario: Runtime state lives outside the code repo
- **WHEN** Sunny writes memory or skills
- **THEN** they are written under `~/.sunny/`, not into the code repository

### Requirement: Provider-agnostic model wiring
The language model SHALL be configured in a single place, defaulting to `claude-opus-4-8` with adaptive thinking, such that changing the model is a localized change that does not touch the agent loop. The model API key SHALL be read from the environment.

#### Scenario: Swap the model
- **WHEN** the configured model id is changed
- **THEN** the agent loop is unaffected and uses the new model

### Requirement: Cacheable, byte-stable system prefix
The always-on system prefix (tool definitions + system instructions + memory core) SHALL be rendered byte-stable — no per-request data (timestamps, UUIDs, remaining budget) and deterministic tool ordering — and marked cacheable so repeated reads within a turn or burst bill at the reduced cached rate. Per-run dynamic context SHALL be injected outside the cached prefix. Cache read/write token counts SHALL be observable per turn.

#### Scenario: Multi-step turn reads the cached prefix
- **WHEN** a turn makes more than one model call
- **THEN** later calls read the stable prefix from cache rather than re-billing it at the full rate
- **AND** the per-turn log reports cache read/write token counts

#### Scenario: No per-request data in the prefix
- **WHEN** the system prefix is built
- **THEN** it contains no timestamps, UUIDs, or other per-request values that would invalidate the cache

### Requirement: Secrets are environment-only
Secret values SHALL be provided only via the environment (a hardened secrets file), never committed to the repository, written to the `~/.sunny/` config, or emitted to logs. Non-secret settings SHALL live in a `~/.sunny/` config file that the user can read and hand-edit.

#### Scenario: Secret is never persisted to disk or logs
- **WHEN** Sunny needs a secret (e.g. the model API key)
- **THEN** it reads it from the environment
- **AND** the secret is not written to the code repo, the config file, or any log

### Requirement: Always-on supervised deployment
Sunny SHALL run as a long-lived supervised service that restarts automatically on crash and survives host reboot, because durability depends on restart survival.

#### Scenario: Crash and reboot recovery
- **WHEN** the service process crashes or the host reboots
- **THEN** the service is restarted automatically and resumes handling messages and durable work
