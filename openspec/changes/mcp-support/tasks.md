> Build plan for the **mcp-support** change — owner-registered external MCP tool servers as a
> bounded exception to the bash-centric model (D-MCP1). This change delivers the MCP
> *capability*; the *enforcement* layer (tool-call gating seam, taint-tracking of MCP results,
> egress control, drift-pinning) is the companion **security-permissions** change, which reads
> the declarations recorded here. D-MCP* decisions are in this change's `design.md`. The ungated
> MCP window is **attended-testing-only** (owner-DM, no autonomous runs).

## Foundations
- [ ] 0 Prefer the AI SDK MCP primitive — add `@ai-sdk/mcp` (v6's home for `createMCPClient`; MCP was removed from `ai` core in v6). Confirm `transport: { type: 'http' }` (Streamable HTTP) needs no `@modelcontextprotocol/sdk` for the header-auth path. Record the corrected evaluation-table row (design "Build principle"). (D-MCP3)

## Server registry (mcp)
- [ ] 1 MCP server registry (`~/.sunny/mcp.json`, in the `~/.sunny` git repo, owner-reviewable): `name` → `{ url, transport, auth?, enabled }`, **references + metadata only, never values** — sibling to the credential registry. `load`/`register`/`list`/`setEnabled`/`remove`. (D-MCP2)

## Install-and-test lifecycle (mcp)
- [ ] 2 `mcp_manage` tool (owner-DM only, sibling to `credential_manage`): `add` (record entry, no connect), `connect`/`probe` (open client → `client.tools()` → enumerate names+descriptions, no calls → report inventory → `close()`), `test` (invoke one low-consequence tool or report the probe), `list`, `enable`/`disable`, `remove`. When auth is missing, direct Sunny to **ask the owner** (via `send_message`) and to have the owner add the backing secret to the `Sunny` vault — never invent a credential. (D-MCP4)

## Connection + auth (mcp)
- [ ] 3 Remote Streamable-HTTP connection layer: `createMCPClient({ transport: { type: 'http', url, redirect: 'error', headers? } })`; `redirect: 'error'` for SSRF hardening; SSE only as a per-server legacy fallback; **local stdio out of scope**. (D-MCP3)
- [ ] 4 Header/bearer auth by name: resolve the entry's `auth` credential name through the credential registry (`resolveByName` → `op://` → value) into `transport.headers.Authorization` at connect time; value never enters model context. (D-MCP5)
- [ ] 5 OAuth 2.1 provider: an `OAuthClientProvider` that stores tokens beside the registry in `~/.sunny` (never surfaced), drives consent through the existing **`browse`** capability, and implements `validateAuthorizationServerURL` to allowlist authorization-server origins before metadata fetch. (D-MCP5)

## Loop integration (mcp / tool-access)
- [ ] 6 Merge enabled servers' tools into the turn loop (`src/agent/loop.ts` tool assembly): per enabled server, `createMCPClient` → `client.tools()` → spread into the loop tool set → `close()` in a `finally` after the turn (connect-per-turn; pooling deferred). Connect failure **degrades gracefully** — omit that server's tools, log, notify the owner once, never fail the turn. **Owner-DM only; never in autonomous/scheduled runs** (the attended-only seam). (D-MCP6/7)
- [ ] 7 Record the D-TA2 exception (tool-access delta): MCP tools are native tools in the loop (the one non-bash capability); MCP results are untrusted content; MCP tool calls are the new tool-call gating seam the command policy does not see — declared here, enforced in `security-permissions`. (D-MCP1/7)

## Dashboard (web-dashboard delta)
- [ ] 8 Read-only **MCP servers** directory, data-driven from the registry + last cached probe: per server — name, **host** (not the token-bearing URL), transport, `auth`-by-name (no values), enabled, last-probed tool inventory. Surfaces `mcp_manage` additions automatically, like the Tools/Skills/Credentials directories. (D-MCP8)

## Verify
- [ ] 9 Exercise the capability under **attended** operation with the **craft** MCP (`https://mcp.craft.do/links/DSVtQGux9Yz/mcp`): `add` → `connect`/`probe` (see craft's tool inventory) → `test` a low-consequence tool → `enable` → confirm the tools are callable in an owner-DM turn → confirm the server appears in the dashboard MCP directory. Then a header-auth and an OAuth server end-to-end. No autonomous/scheduled MCP runs until `security-permissions` lands. (D-MCP4/6/8)
