## Why

Sunny is single-user today: only the owner's identities are authorized, and every powerful capability is unlocked by a proxy (the message is a DM, which can only be the owner because non-owner DMs are rejected). Devon wants to let designated **family** members talk to Sunny with the same elevated permission level he has — both in direct messages and, later, in family-only group threads — while keeping everyone else locked out. This is the first, deliberately blast-radius-limited step toward multi-player: by trusting only `owner ∪ family` and rejecting everywhere else, we get co-piloting for the household without yet building the full security/enforcement model (that lands in the in-flight `security-permissions` change).

## What Changes

- **Trust tiers replace the binary owner check.** Introduce a `family` roster in config (mirroring `owner`). The authorizer resolves an inbound sender to a role (`owner` | `family`) and a derived `isTrusted` flag. `isOwner` keeps meaning *literally the owner* so a small set of owner-only carve-outs survives.
- **Tool-gating moves from thread-kind to trust-tier.** Today the powerful tools (`bash`, `file_read`, `delegate_task`, `message_subagent`) are gated on `ownerDm` (= "is a DM"). This flips to gate on `isTrusted`, so a family DM gets owner-equivalent capabilities **by intent** rather than by accident. (Devon has explicitly accepted this blast radius; tighter lockdown comes with `security-permissions`.)
- **Phase 1 — Family DMs:** authorize family-member DMs (today rejected), tag the role/trust on the inbound event, and grant the elevated toolset.
- **Phase 2 — Family groups:** authorize a group only when **every** participant is trusted (owner need not be present); a single outsider silences the whole group; the roster is re-checked every message and fails **closed**. Sunny participates as a passive assistant using per-turn discretion (`send_message`/`stay_silent`) rather than requiring an `@mention`, which needs a subscription bootstrap.
- **Per-person profile docs.** `SUNNY.md` (operating notes) and the owner's `USER.md` stay always-loaded; each family member gets an auto-created profile doc under `memory/people/<id>.md`, loaded for the participants present in the thread and written to as Sunny learns durable facts about them. `memory_write` routes person-facts to the right doc. Editing the owner's `USER.md` is owner-only.
- **Privacy by discretion, not siloing.** Rather than withholding the owner's profile from family-facing contexts, the system prompt instructs Sunny to use judgment about sharing what it knows about one person with another.
- Accepted trust boundary for this change: **identity == phone/email**, the same trust class already used for the owner. No cryptographic pairing here.

## Capabilities

### New Capabilities
<!-- none; this extends existing capabilities -->

### Modified Capabilities
- `messaging-gateway`: sender authorization becomes trust-tier (owner/family) with owner tagging; non-trusted DMs still rejected; **group membership validation** (all-trusted-or-silent, re-checked per message, fail-closed); group **subscription/participation** without requiring an `@mention`; tool exposure gated on trust-tier instead of thread-kind; the `family` roster config.
- `agent-memory`: per-person profile documents under `memory/people/<id>.md` (auto-created, loaded for present participants, written to as facts are learned); `memory_write` routing of person-facts to the correct doc; owner `USER.md` remains always-loaded and owner-edit-only; discretion guidance for cross-person disclosure.

## Impact

- **Code:** `src/gateway/auth.ts` (Authorizer → tiers/roster), `src/config/index.ts` (family roster schema), `src/gateway/sendblue.ts` (group roster fetch + membership check + subscription bootstrap in `dispatch`/handlers), `src/gateway/types.ts` + `src/db/schema.ts` (role/trust on the event/row), `workflows/conversation.ts` (`buildTools` gating flips to trust-tier), `src/memory/index.ts` + `src/agent/prompt.ts` + `src/agent/instructions.ts` (per-person docs, loading by participants, write routing, discretion prompt), `src/agent/tools/memorySpecs.ts` (write-target routing).
- **Data/config:** new `config.family` roster in `~/.sunny/config.json`; new `memory/people/` directory in the private `state` repo.
- **Relationship:** establishes the **trust-tier** as the gating axis that the in-flight `security-permissions` change will build enforcement on (this change does not implement enforcement, approvals, or crypto-pairing). Group attribution (speaker prefixes) already exists and is reused as-is.
- **Trust boundary:** widens the set of fully-trusted identities from "the owner" to "owner + a few family numbers/emails"; a spoofed/compromised family identity gains full access — accepted for this change, to be hardened later.
