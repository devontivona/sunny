# Email setup (himalaya) — end-to-end runbook

This wires Sunny's **email** capability: the `himalaya` CLI driven via the `bash` tool,
with the mailbox password pulled from 1Password and injected per-command (never seen by
the model). Steps 1–4 are host setup you do once; step 5 deploys the skill; step 6 tests.

> **What's in code already:** the `bash` tool's per-command credential injection +
> output masking (D-TA5), the credential registry + `credential_manage` (D-CR5), and the
> 1Password resolver (D-CR1/2). What's *not* automatable and is on you: installing
> himalaya, writing the account config, and putting the mailbox password in the vault.

## Prerequisites

- `OP_SERVICE_ACCOUNT_TOKEN` set for the Sunny process (the read-only Service Account for
  the dedicated `Sunny` vault — see `.env.example`).
- A mailbox to use. For Gmail / any 2FA account, generate an **app-specific password** —
  himalaya logs in over IMAP/SMTP, not OAuth.

## 1. Install himalaya on the host

```bash
# Pick one; see https://github.com/pimalaya/himalaya for current install options.
cargo install himalaya            # or: brew install himalaya / package manager
himalaya --version
```

## 2. Configure the account

Create `~/.config/himalaya/config.toml`. The **invariant that matters** (regardless of
himalaya version): the password is read from the `$HIMALAYA_PASSWORD` env var that Sunny
injects — it is never stored on disk. Template (verify keys against your himalaya version,
`himalaya doc` / the project wiki — the config schema changes between releases):

```toml
[accounts.sunny]
default = true
email = "sunny@waywardlane.com"
display-name = "Sunny"

backend.type = "imap"
backend.host = "imap.example.com"
backend.port = 993
backend.encryption = "tls"
backend.login = "sunny@waywardlane.com"
backend.auth.type = "password"
backend.auth.command = "printf '%s' \"$HIMALAYA_PASSWORD\""

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.example.com"
message.send.backend.port = 465
message.send.backend.encryption = "tls"
message.send.backend.login = "sunny@waywardlane.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.command = "printf '%s' \"$HIMALAYA_PASSWORD\""
```

Sanity-check it manually once (export the var yourself, just for this test):

```bash
HIMALAYA_PASSWORD='<the-app-password>' himalaya envelope list -s 5
```

If that lists mail, the config is right. Then **unset it** — Sunny supplies it per-command.

## 3. Put the password in the Sunny vault

In 1Password, add the mailbox/app password to the dedicated **Sunny** vault (only the
Sunny vault — the Service Account can't read anything else). Note its reference, e.g.
`op://Sunny/sunny-email/password`.

## 4. Register the credential with Sunny

Over iMessage, tell Sunny the reference. Sunny records it (and verifies it resolves
without revealing the value):

> You: "The Sunny mailbox password is at op://Sunny/sunny-email/password — register it as `email`."

Sunny → `credential_manage(action: "register", name: "email", reference: "op://Sunny/sunny-email/password", purpose: "mailbox login")`
→ "Registered email → op://Sunny/sunny-email/password and verified it resolves. ✓"

## 5. The email skill

Nothing to deploy — the `email` skill is a **bundled seed** (`src/skills/seeds.ts`) and is
written into `~/.sunny/skills/email/SKILL.md` automatically on startup (if absent), the same
way the memory core is seeded. It's in Sunny's always-on SKILL index from the first turn. You
can edit it in place afterward; your edits are preserved across restarts.

## 6. Test end-to-end

> You: "check my email"

Expected: Sunny loads the `email` skill and runs, e.g.,
`bash(command: "himalaya envelope list -s 20 -o json", credentials: { HIMALAYA_PASSWORD: "email" })`,
then summarizes the inbox. The password is resolved from 1Password into that one
subprocess's env and **masked from the output** — confirm it never appears in Sunny's
turn log or the dashboard.

To test sending: ask Sunny to draft an email; it should confirm the recipient/subject/body
with you before running `himalaya … send` (sending acts as you).
