## Why

`agent-tooling` deliberately deferred MCP. Its AI SDK evaluation table recorded the
decision — *"MCP client … **Wrap** — use for external MCP tool servers when needed"* —
but never built it, because every capability in that change is a **CLI over bash** or a
**skill over bash** (D-TA2), and MCP is neither. MCP servers expose **structured tools**
that have no CLI to shell out to: the server *is* the interface. The owner wants Sunny to
**install and test its own MCP servers on request** — e.g. *"add the craft MCP, it's at
`https://mcp.craft.do/links/DSVtQGux9Yz/mcp`"* — the same **request-and-tell** shape Sunny
already uses for credentials (D-CR5), one rung up: register → connect → enumerate the tools
the server exposes → probe → report back.

This change delivers the MCP **capability**. Consistent with the `agent-tooling` →
`security-permissions` split this branch establishes, it **declares** the new consequence
surface MCP introduces and **defers enforcement** to `security-permissions`. MCP tool calls
are invisible to the bash command policy, so they are a **new gating seam at the tool-call
layer** — the fourth alongside command / action / credential (D-TA0). Until that seam is
enforced, MCP tools load **attended-only** (owner-DM, never autonomous), exactly like
`installed/` skills and the host `bash` tool today.

## What Changes

- **mcp (new capability)** — an **MCP server registry** (`~/.sunny/mcp.json`, in the
  `~/.sunny` git repo, owner-reviewable/reversible) that is a **sibling to the credential
  registry**: each entry is `name`, `url`, `transport`, optional `auth`, `enabled` — **never
  secret values**. An `mcp_manage` tool (owner-DM only, **sibling to `credential_manage`**)
  performs the request-and-tell lifecycle: `add` / `connect` (probe → enumerate tools) /
  `test` / `list` / `enable` / `disable` / `remove`. The turn loop, at assembly, opens a
  client per enabled server, merges `await client.tools()` into the loop tool set, and
  `close()`s after the turn (connect-per-turn; pooling deferred). Built on the AI SDK
  primitive **`@ai-sdk/mcp`** (`createMCPClient`), **remote Streamable-HTTP transport**
  (`type: 'http'`), with `redirect: 'error'` SSRF hardening. **Auth** flows through the
  existing credential plumbing — a bearer/header credential is referenced **by name** (D-CR5)
  and injected into the transport headers in the connection layer, never into model context;
  **OAuth 2.1** is handled by an `OAuthClientProvider` that stores tokens beside the registry,
  drives consent through the existing **`browse`** capability, and allowlists
  authorization-server origins (`validateAuthorizationServerURL`).
- **tool-access (modified)** — record the **bounded D-TA2 exception**: MCP is the one
  capability delivered as **native tools injected into the loop**, not a CLI/skill over bash.
  Record that MCP tool **results are untrusted content** (prompt-injection class) and that
  MCP tool calls bypass the command policy (the new tool-call gating seam).
- **web-dashboard (modified, delta)** — a read-only **MCP servers** directory (name, host,
  transport, auth-by-name, enabled, last-probed tool inventory — **no values**), data-driven
  from the registry like the existing Tools / Skills / Credentials directories.

**Deliberately deferred to `security-permissions`:** the **tool-call gating seam** (approval
on MCP tool invocations — MCP's analogue of the bash AST command policy), **taint-tracking**
of MCP results + routing untrusted output to a no-credential subagent, **egress control** to
remote MCP hosts, and **drift-pinning** of a server's tool set against rug-pull. The
*declarations* here are what that change enforces.

**Deferred by scope (future MCP work, not `security-permissions`):** **local stdio** MCP
servers (a subprocess reopens the host/command surface — out of scope; remote HTTP only here),
and **per-tool selection / progressive disclosure** when a server exposes many tools and
strains the loop context budget (parallel to skills' `pgvector` deferral, D-SK3).

## Capabilities

### New Capabilities
- **mcp** — owner-registered external MCP tool servers: a reviewable server registry, an
  `mcp_manage` request-and-tell lifecycle (add/probe/test/enable/remove), remote
  Streamable-HTTP connection with header- and OAuth-based auth resolved without exposing
  values to the model, and per-turn merge of the servers' tools into the agent loop. Gating
  of MCP tool calls is deferred to `security-permissions` (the tool-call seam).

### Modified Capabilities
- **tool-access** — record MCP as the **one bounded exception** to bash-centric capability
  (D-TA2): native tools in the loop, not a CLI over bash; MCP results are untrusted content;
  MCP tool calls are a new consequence seam the command policy does not see.
- **web-dashboard** — add a read-only **MCP servers** directory.

## Impact

Builds on **`agent-tooling`** — reuses the **credential registry** (auth by name, D-CR5),
the **loop tool assembly** (`src/agent/loop.ts`, where MCP tools merge), the **`browse`
capability** (OAuth consent), and the **data-driven dashboard directories**. Adds one
dependency: **`@ai-sdk/mcp`** (v6's home for `createMCPClient`; MCP was removed from `ai`
core in v6). **Pairs with `subagents`** (route untrusted MCP results to a no-credential
child) and **`observability`** (MCP tool spans in the turn trace). **Feeds
`security-permissions`**, which enforces the tool-call gating seam, taint, egress, and
drift-pinning declared here. The ungated window is **attended-testing-only** — no
autonomous/scheduled runs of MCP tools until `security-permissions` lands.
