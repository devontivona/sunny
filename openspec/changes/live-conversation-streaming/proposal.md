## Why

When Sunny is actively working, the only signal Devon gets in iMessage is a typing indicator — opaque about what Sunny is actually doing (which tools, how many steps, whether it's stuck). The dashboard's Conversation page is a static, oldest-first snapshot that must be manually refreshed and shows nothing about in-flight work. There is no way to glance at "what is Sunny doing right now," and the same blindness applies to long-running background (Tier-2) jobs. This change turns the Conversation page into a live observability surface so Devon can watch Sunny think and act in real time.

## What Changes

- **Reverse the Conversation view to most-recent-first** so the newest activity (including the in-flight turn) is at the top without scrolling.
- **Render per-step activity**, not just delivered messages: each turn expands into its steps — model thinking/scratch, tool calls (name + arguments) and their results/errors, and step boundaries — so a turn reads as a trajectory, not a single bubble.
- **Stream active work live**: while a turn or job is running, the page receives incremental updates (new steps, tool starts/finishes, token deltas, the in-progress assistant text) and reflects them without manual refresh, then settles to the persisted record on completion.
- **Live indicator on the home page**: when Sunny is actively streaming a turn or running a job, the home page shows an "active now" indicator with a shortcut that deep-links to the live Conversation (or job) view.
- **Reuse the live view for background jobs**: actively-running Tier-2 durable jobs render in the same step-stream UI as conversational turns, so a running job is observable the same way a turn is.
- **Additional live debug info**: surface the current run's status (running / waiting-on-tool / finished / errored), elapsed time, step count, live token usage (incl. cache read/write), the active model/effort, and a link to the run's Langfuse trace — to make in-flight runs diagnosable.
- The view remains strictly **observe-only**: streaming adds no control affordance (no send, cancel, or edit).

## Capabilities

### New Capabilities
<!-- none — this extends the existing dashboard capability -->

### Modified Capabilities
- `web-dashboard`: The **Conversation view** requirement changes — reverse-chronological ordering, per-step (tool-call) rendering, and a live stream of in-flight turn/job activity. A new requirement adds a **home-page live indicator** with a shortcut to the active run, and the live view is **reused for actively-running background jobs**. The **Activity and health view** gains live in-flight run state. All additions stay read-only (no new control surface).
- `observability`: No requirement change to what is captured, but the dashboard becomes a live consumer of the per-step activity already emitted for turns and jobs; if a live event source is not already exposed for in-flight runs, this change introduces one (read-only) alongside the existing trajectory capture.

## Impact

- **Dashboard back end** (`/dashboard/api`, Nitro routes): a new read-only live-event endpoint (SSE) that emits step/tool/token/status events for the active turn(s) and running jobs, plus an "active runs" summary endpoint for the home indicator.
- **Agent run loop & durable jobs**: an in-process publish seam so the run loop and Tier-2 jobs emit live step events to subscribers (in addition to existing persistence/telemetry). Must not alter the byte-stable cached system prefix or leak secrets.
- **Dashboard front end** (React SPA): rework the Conversation page (reverse order, per-step components, live subscription), a home-page live banner, and shared step-stream components reused by the jobs view.
- **No new persistence required** by default — live events are derived from the same data already produced for messages/trajectories; durability and telemetry are unchanged.
- **Security**: live endpoints sit behind the existing dashboard auth gate; events are redacted on the same path as other telemetry (no secret values, no token-bearing URLs).
