# Proposal: watchdog-activity

## Why

The turn watchdog is a flat wall-clock ceiling (`turnWatchdogMs`): it exists to catch genuinely stalled model streams, but it cannot distinguish a hang from a long-but-healthy turn. On 2026-07-12 it executed a perfectly productive 25-step email-research turn at exactly minute 10 — every WDK step completing, a bash call mid-flight — and the owner experienced it as a crash. Three compounding problems surfaced: (1) the ceiling kills honest work while a real hang still waits the full budget to be caught; (2) when the watchdog abandons a run, the dashboard shows it as running forever (the stream-bridge `finally` that settles the LiveBus entry never runs, because the cancelled run's stream reader never resolves); (3) the owner saw nine minutes of dead air first — the progress translator chose silence at steps 16/19/22, and the model ground through a long research sweep inline instead of delegating it.

## What Changes

- **Activity-aware watchdog**: replace the flat race with a two-threshold guard — abandon when the run has produced NO observable activity (run-stream chunks: model deltas, tool calls, tool results at step boundaries) for `turnInactivityMs` (default 600000 — the old flat budget's strength, now applied only to true silence), OR when total runtime exceeds the hard cap `turnWatchdogMs` (config; 3600000 on the live host). A long tool-heavy turn keeps running as long as it keeps moving; a stalled stream is caught just as fast as before.
- **Dashboard shows abandoned runs as ended (bug fix)**: the abandon path explicitly settles the LiveBus turn entry (`finishTurn(runId, 'errored')`, idempotent with the bridge's own settle) and cancels the bridge's stream reader so the bridge task can't leak; the Conversation/Activity views stop showing a killed turn as live.
- **Instruction improvements** (prompt + builtin skill + translator):
  - Conversational prompt + delegation builtin skill: a task that will take many sequential tool calls (research sweeps, mailbox searches, batch processing) should be DELEGATED to a subagent — the turn stays short and steerable, and the sweep survives independently.
  - Translator: silence stops being acceptable on long grinds — when many steps have passed since the last update, compose a one-line status instead of declining.

## Capabilities

### New Capabilities
_None._

### Modified Capabilities
- `durable-execution`: adds turn-watchdog requirements (previously unspecced): activity-aware abandonment (inactivity threshold + hard cap), and abandonment SHALL settle the run's observable state (dashboard live view shows a terminal state, never a phantom "running").

## Impact

- **Code**: `src/agent/turnWatchdog.ts` (activity-aware race), `src/agent/durableRouter.ts` (activity feed from the stream bridge; abandon path settles LiveBus + cancels the bridge reader), `src/config/index.ts` (`turnInactivityMs` knob), `src/observability/live.ts` (idempotent `finishTurn` if not already), `src/agent/translator.ts` (long-grind update rule), `src/agent/prompt.ts` + `agent/builtin/skills/delegation/SKILL.md` (delegate-long-sweeps guidance).
- **Config**: new optional `turnInactivityMs` (default 600000); `turnWatchdogMs` semantics sharpen to "hard cap" (README/AGENTS note).
- **No schema changes; no dashboard UI changes** (the fix is that existing views receive the settle event).
