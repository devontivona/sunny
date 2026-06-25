# Browse setup (agent-browser) — end-to-end runbook

This wires Sunny's **browse** capability: the `agent-browser` CLI driven via the `bash` tool,
with site logins pulled from 1Password and injected per-command (never seen by the model).
Steps 1–2 are host setup you do once; step 3 deploys the skill; steps 4–5 cover research and a
credentialed login that persists across runs.

> **What's in code already:** the `bash` tool's per-command credential injection + output
> masking (D-TA5), the credential registry + `credential_manage` (D-CR5), the 1Password
> resolver (D-CR1/2), and the bundled `browse` skill (`src/skills/seeds.ts`). What's *not*
> automatable and is on you: installing `agent-browser`, putting site logins in the vault, and
> the first attended login. Approval-gating of credentialed *actions* lands with
> `security-permissions`; until then this is **attended-testing-only** — no autonomous or
> scheduled credentialed/destructive browsing.

## Prerequisites

- `OP_SERVICE_ACCOUNT_TOKEN` set for the Sunny process (read-only Service Account for the
  dedicated `Sunny` vault — see `.env.example`).
- Node available on the host (agent-browser drives a CDP browser).

## 1. Install agent-browser on the host

```bash
npm i -g agent-browser
agent-browser install            # downloads the matching Chrome (~180 MB)
agent-browser install --with-deps  # Linux: add this if the browser fails to launch
agent-browser --version
```

agent-browser is a **host CLI**, not an npm dependency of this repo — same posture as
`himalaya`. Sunny drives it over the `bash` tool; it never installs it itself. The CLI serves
its own version-matched usage guide — `agent-browser skills get core` (and `skills list`) — which
is the source of truth for verbs; the `browse` skill points Sunny there.

## 2. (Credentialed sites only) put the login in the Sunny vault

In 1Password, add the site's password to the dedicated **Sunny** vault (only the Sunny vault —
the Service Account can't read anything else). Note its reference, e.g.
`op://Sunny/example-login/password`. Research-only browsing needs no credential.

## 3. The browse skill

Nothing to deploy — the `browse` skill is a **bundled seed** (`src/skills/seeds.ts`) and is
written into `~/.sunny/skills/browse/` automatically on startup (if absent), along with its
`references/agent-browser.md` (engine details, durable-session flags, Playwright fallback) and
`references/per-site-skills.md` (installing/authoring per-site skills). It's in Sunny's always-on
SKILL index from the first turn. Edit it in place afterward; your edits are preserved across
restarts and round-trip to the canonical skill repo.

## 4. Test research mode (no credentials)

> You: "read me the top of <some public page>"

Expected: Sunny loads the `browse` skill and runs agent-browser in an **ephemeral** context
(e.g. `agent-browser open "<url>" --ephemeral`), then summarizes — treating the page as
untrusted data. Nothing is persisted.

## 5. Get a persistent credentialed session

Two paths — prefer the first for the owner's own accounts.

**A. Owner logs in once (no password touches Sunny).** Best for OAuth/SSO/2FA. The owner signs
in, then Sunny captures the authenticated state into a named session it reuses:

```bash
# Owner: start Chrome with remote debugging and log into the site as normal.
google-chrome --remote-debugging-port=9222   # (macOS/Windows: see `skills get core`)
# Sunny: capture that state into a named session (stored under ~/.agent-browser/).
agent-browser --auto-connect --session-name example state save ~/.agent-browser/example.json
```

The password never enters Sunny's context at all. A later run with `--session-name example`
reuses the login without re-authenticating — that persistence-across-runs is the thing to verify.

**B. Scripted login from the vault** (when there's no existing session to import). Let Sunny
**discover** the reference (same flow as email — you don't copy the `op://` path):

> You: "I added the example.com login to the Sunny vault — register it as `example-login`,
> then log into example.com."

Sunny → `credential_manage(action: "discover")` → `credential_manage(action: "register", name:
"example-login", reference: "op://<vault-id>/<item-id>/password")` (ID-based reference, verified
to resolve, value never shown). Then it seeds the session by **name**, piping the secret over
stdin so it's never a CLI arg:

```
bash(
  command: "printf '%s' \"$SITE_PASSWORD\" | agent-browser auth save example --url https://app.example.com/login --username user@example.com --password-stdin",
  credentials: { SITE_PASSWORD: "example-login" }
)
```

The password is resolved from 1Password into that one subprocess's env, piped via stdin, and
**masked from the output** — confirm it never appears in Sunny's turn log or the dashboard. For
encryption at rest, set `AGENT_BROWSER_ENCRYPTION_KEY` for the Sunny process. (A 1Password
credential-provider *plugin* is the clean native integration long-term, but is a separate build.)

## 6. (Optional) per-site skills

To teach Sunny a specific site, either install a browse.sh catalog entry as a SKILL.md or have
Sunny self-author one — see `references/per-site-skills.md` in the skill. Per-site skills are
engine-agnostic SKILL.md files; the `github.com/browserbase/skills` capability skills are
intentionally **not** adopted.
