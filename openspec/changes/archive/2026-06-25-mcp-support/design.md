# Design — MCP Support (owner-registered external tool servers)

> Sunny installs and tests its own **MCP servers** when the owner gives the details. MCP
> is the one capability that is **native tools injected into the agent loop**, not a CLI or
> skill over bash — a bounded, deliberate exception to D-TA2. This change delivers the MCP
> *capability*; the *enforcement* half (a tool-call gating seam, taint-tracking of MCP
> results, egress control, drift-pinning) lives in the companion **security-permissions**
> change, which reads the declarations recorded here — the same capability-first/enforce-
> later split `agent-tooling` established.

## Build principle: wrap the AI SDK MCP primitive (verified against v6)

`agent-tooling`'s build principle stands — *prefer AI SDK primitives, don't hand-roll* — but
its evaluation table is **stale on this one row**. It recorded
`experimental_createMCPClient` from `ai` core "verified against `ai@6.0.206`." That is a v5
fact: **MCP was extracted out of `ai` core in v6**. Grepping `node_modules/ai/dist/*.d.ts`
finds zero MCP symbols, confirming it.

**Corrected evaluation (verified against the installed `ai@6.0.206` and `@ai-sdk/mcp@1.0.x`):**

| Need | AI SDK v6 provides? | Decision |
|---|---|---|
| MCP client | `createMCPClient` from **`@ai-sdk/mcp`** (extracted from `ai` core; `experimental_` prefix dropped) | **Wrap** — one new dep, `@ai-sdk/mcp` |
| Remote transport | `transport: { type: 'http', url, headers, redirect }` — **Streamable HTTP**, zero extra deps (`@modelcontextprotocol/sdk` NOT required for `type:'http'`) | **Use `type: 'http'`** (SSE is legacy fallback only) |
| Tool adaptation | `await client.tools()` → AI SDK `tool()`-compatible map | **Spread into the loop tool set** (`loop.ts`) |
| Header/bearer auth | `transport.headers.Authorization` | **Resolve a credential by name (D-CR5) at connect time** |
| OAuth 2.1 | `transport.authProvider: OAuthClientProvider` (SDK carries the protocol) | **Implement the provider** — token store + `browse` consent + origin allowlist |
| Lifecycle | `await client.close()` required | **connect-per-turn, close in `finally`** (D-MCP6) |

So MCP stays a *wrap* of an AI SDK primitive (the agent-tooling principle holds) — it just
wraps `@ai-sdk/mcp` rather than `ai` core, and the protocol details (Streamable HTTP, OAuth)
are carried by the package, not hand-rolled.

---

## Decisions

- **D-MCP1 — MCP is the one bounded exception to bash-centric capability (D-TA2).** Every
  other capability in `agent-tooling` is a CLI over bash or a skill over bash. MCP cannot be:
  an MCP server exposes **structured tools with no CLI to shell out to** — the server *is* the
  interface (there is no `craft` CLI). So MCP tools are **native `tool()` definitions injected
  into the loop tool set**, the one place Sunny adds tools that are not the thin host surface.
  The exception is **bounded**: it covers only tools fetched from an **owner-registered** MCP
  server in the registry (D-MCP2); it does not loosen D-TA2 for anything else. *(Rejected:
  forcing MCP through a bash CLI wrapper — there is no general MCP-over-CLI bridge that
  preserves typed tool schemas, and it would fight both the protocol and the SDK.)*

- **D-MCP2 — An MCP server registry, sibling to the credential registry (D-CR5).** Servers
  are recorded in `~/.sunny/mcp.json` inside the `~/.sunny` git repo — reviewable, reversible,
  owner-editable like memory, skills, and credentials. Each entry holds `name`, `url`,
  `transport` (`'http'`), optional `auth` (a **reference**, not a value — a credential **name**
  for header auth, or an OAuth marker), and `enabled`. It holds **references + metadata, never
  secret values** — exactly the credential-registry contract (D-CR5). The owner curating this
  file (and adding any backing secret to the `Sunny` vault) **is the authorization** to use the
  server, mirroring "the vault is the authorization boundary" (D-CR3).

- **D-MCP3 — Remote Streamable-HTTP transport only (this change).** Connect via
  `createMCPClient({ transport: { type: 'http', url, … } })`. SSE (`type: 'sse'`) is the
  **legacy fallback** used only if a specific server requires it. **Local stdio** MCP servers
  (a `npx`/binary subprocess) are **out of scope** — a subprocess drags MCP back onto the
  host/command surface and reopens the bash-gating question this change is trying to keep
  clean; defer to a follow-up. Set **`redirect: 'error'`** so the transport refuses redirects
  (SSRF hardening) against servers Sunny does not control.

- **D-MCP4 — Request-and-tell install + probe + test, via `mcp_manage` (sibling to
  `credential_manage`).** An owner-DM-only tool with verbs:
  - `add` — record `name` + `url` + optional `auth` in the registry (no connection yet).
  - `connect` / `probe` — open a client, `await client.tools()`, **enumerate the exposed tools**
    (names + descriptions, no calls), report the inventory to the owner, `close()`.
  - `test` — invoke one **low-consequence** tool (or rely on `probe` when no safe call exists)
    and report the result, so the owner sees the server actually works before enabling it.
  - `list` / `enable` / `disable` / `remove`.
  When a server needs auth Sunny lacks, `mcp_manage` directs Sunny to **ask the owner** (via
  `send_message`) for the token/OAuth details and add the backing secret to the `Sunny` vault —
  the same request-and-tell flow as a missing credential (D-CR5) — never to invent one.

- **D-MCP5 — Auth resolved without exposing values to the model.** Two paths, both keep the
  value out of model context (D-CR2):
  - **Header/bearer:** the entry's `auth` is a **credential name**; the connection layer
    resolves it through the registry (`resolveByName` → `op://` → value) and sets
    `transport.headers.Authorization` at connect time. The model only ever handles the name.
  - **OAuth 2.1:** an `OAuthClientProvider` implementation stores tokens in a registry-adjacent
    store (in `~/.sunny`, like credentials — references/tokens reviewable, **never surfaced**),
    drives interactive consent through the existing **`browse`** capability, and implements
    `validateAuthorizationServerURL` to **allowlist authorization-server origins** before
    metadata is fetched. 1Password stays source-of-truth for any static secret (D-CR1/2).

- **D-MCP6 — Connection lifecycle: connect-per-turn, close-after (MVP); pooling deferred.**
  At turn assembly (`loop.ts`), for each **enabled** server: `createMCPClient` → `client.tools()`
  → merge into the loop tool set → register; `await client.close()` in a `finally` after the
  turn. Simple and safe — **no long-lived connection to a third party to manage**, and reads are
  always fresh (a registry edit is picked up next turn, like skills). A connect failure
  **degrades gracefully**: that server's tools are simply absent for the turn, logged, and the
  owner is notified once — it never fails the turn. A **cached/pooled client** keyed by server
  config is a documented future optimization (saves per-turn connect latency).

- **D-MCP7 — MCP introduces a new consequence + taint surface; enforcement deferred to
  `security-permissions`.** This change **declares**; that change **enforces**:
  - **Tool-call gating seam (the 4th seam).** MCP tool calls are **invisible to the bash AST
    command policy** (D-TA1) — they are not commands. So consequence-gating MCP requires a new
    seam at the **tool-call layer**, MCP's analogue of the command policy, alongside
    command / action / credential (D-TA0). Until it lands, MCP tools load **ungated →
    attended-only**, owner-DM-only, **never in autonomous/scheduled runs** (the `installed/`
    skill / host-`bash` posture).
  - **MCP results are untrusted content.** Tool results from a third-party server are the same
    prompt-injection class as untrusted page content and untrusted skill bodies — the hook for
    **taint-tracking** + routing to the **no-credential subagent** (the `subagents` change).
  - **Egress.** A remote MCP server is **egress to a third party** → egress control.
  - **Drift / rug-pull.** A remote server can change its tool set or tool descriptions between
    connects; the registry entry is the hook for **drift-pinning + review** (parallel to skill
    drift-pinning). `probe` surfaces the current inventory the owner reviews.

- **D-MCP8 — MCP servers surface in a read-only dashboard directory.** A new directory
  parallel to Tools / Skills / Credentials: per server — `name`, **host** (not the full
  token-bearing URL), `transport`, `auth`-by-name (no values), `enabled`, and the
  **last-probed tool inventory**. Data-driven from the registry plus the cached `probe` result,
  so a server added via `mcp_manage` surfaces automatically, exactly like the existing
  directories.

## Risks / Trade-offs

- **Ungated MCP tool window:** MCP tool calls bypass the command policy and load ungated until
  `security-permissions` adds the tool-call seam — mitigated by the **attended-testing-only**
  posture (owner-DM, no autonomous runs) and by keeping the registry to **owner-added** servers.
- **MCP results are untrusted instructions:** a malicious/compromised server can attempt prompt
  injection via tool results — mitigated short-term by attended operation; the durable control
  is taint-tracking + the no-credential subagent (`subagents`/`security-permissions`).
- **OAuth against untrusted servers:** an open redirect / rogue authorization server is the risk
  — mitigated by `validateAuthorizationServerURL` origin allowlisting and `redirect: 'error'`;
  full hardening (token rotation, consent re-review) folds into `security-permissions`.
- **Per-turn connect latency:** connect-per-turn adds a round-trip per enabled server each turn
  — accepted for MVP simplicity and freshness; pooling is the documented optimization (D-MCP6).
- **Tool-count context bloat:** a server exposing many tools enlarges the loop tool set —
  accepted at MVP server counts; per-tool selection / progressive disclosure is deferred
  (parallel to skills' `pgvector` deferral, D-SK3). The owner can `disable` a noisy server.
