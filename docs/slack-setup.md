# Slack channel setup (add-slack-channel)

Sunny's Slack channel is a **DM-only assistant** in v1: DM the bot and full
conversational turns run, same personality and reply lane as iMessage. Channel
traffic and @mentions are received but stay silent until group participation
ships (the manifest below already requests those scopes so that's a config
change later, not a re-install). Proactive speech (schedules, notifications,
relays) stays on iMessage.

## 1. Create the Slack app

[api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a
manifest** → pick the workspace → paste:

```yaml
display_information:
  name: Sunny
  description: Personal AI assistant
features:
  app_home:
    # Without the messages tab, Slack shows "Sending messages to this app has
    # been turned off" and DMs are impossible — this IS the product in v1.
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  # Agent messaging experience (agent_view): upgrades the DM in place with a
  # native thinking indicator + suggested prompts (the driver sets
  # `agentView: true`). Enabling the feature auto-adds the `assistant:write`
  # scope. Without this the classic bot DM has no typing-indicator surface.
  agent_view:
    agent_description: Personal AI assistant
  bot_user:
    display_name: sunny
    always_online: true
oauth_config:
  scopes:
    bot:
      # DM assistant (v1)
      - im:history
      - im:read
      - im:write
      - chat:write
      - users:read
      - files:read
      - files:write
      # Agent messaging experience — the thinking/status indicator. Slack
      # auto-adds this when you enable the agent feature; listed for clarity.
      - assistant:write
      # Future-proofing: group/@mention participation later is a roster/policy
      # change, not an app re-install. All of this traffic stays silent in v1.
      - app_mentions:read
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - mpim:history
      - mpim:read
      # Message search (future tool): the granular search scopes are BOT scopes,
      # so `search.messages` runs on the bot token — no separate user token.
      # Broad by nature (private channels, DMs, files, users); granted now on the
      # reinstall so the future tool needs no re-authorization. Trim to what the
      # tool actually needs when it's built.
      - search:read.public
      - search:read.private
      - search:read.im
      - search:read.mpim
      - search:read.files
      - search:read.users
settings:
  event_subscriptions:
    request_url: https://snny.ai/webhooks/slack
    bot_events:
      - message.im
      - app_mention
      # Agent messaging experience DM-open + active-view signals (agent_view).
      - app_home_opened
      - app_context_changed
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Note: the events URL must be live when you save it — Slack sends a
`url_verification` challenge that the running service answers (the adapter
handles it). Deploy the Slack-enabled build first, or re-verify after restart.

The granular `search:read.*` scopes are **bot** scopes, so message search will
run on the bot token already in `SLACK_BOT_TOKEN` — no separate user token. The
tool that uses them is future work; nothing in v1 requires them yet.

## 2. Configure the host

1. **Install App** to the workspace → copy the **Bot User OAuth Token**
   (`xoxb-…`) → `SLACK_BOT_TOKEN`.
2. **Basic Information** → **Signing Secret** → `SLACK_SIGNING_SECRET`.
   Both go in the hardened systemd EnvironmentFile (same place as `SENDBLUE_*`).
3. Add your Slack **member ID** to `owner.identities` in the sunny config,
   alongside your phone/email. Find it: your Slack profile → **⋯** → **Copy
   member ID** (looks like `U0123ABCDEF`). Without this, Sunny fails closed and
   your DMs get silence.
4. Restart the service (`systemctl --user restart sunny` — deploy policy applies).

Updating an already-installed app: paste the manifest changes on the app's
**App Manifest** page, then **OAuth & Permissions → Reinstall to Workspace** to
grant the new scopes (`assistant:write`, `search:read`). The bot token is
unchanged; a User OAuth Token (`xoxp-…`) appears after you approve the user
scope.

## 3. Verify

- Slack app **Event Subscriptions** page shows the request URL **Verified**.
- DM the bot → Sunny replies in the DM.
- While Sunny is working on a longer DM turn → a native thinking indicator shows
  in the conversation (agent_view + `assistant:write`).
- Have a non-rostered coworker DM it → silence, and the drop appears in logs
  (`unauthorized sender; not triggering agent`).
- @mention the bot in a channel → silence (`non-DM Slack event ignored`).
- A scheduled/proactive message still lands on iMessage, not Slack.

## Removing the channel

Unset `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` and restart — Sunny boots
without the Slack driver and `/webhooks/slack` answers 404. iMessage is
unaffected.
