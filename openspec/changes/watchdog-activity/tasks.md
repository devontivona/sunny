# Tasks: watchdog-activity

## 1. Activity-aware watchdog

- [x] 1.1 Generalize `raceTurnWatchdog` to `{inactivityMs, maxMs, lastActivityAt}` with a ~15s ref'd check interval, `TurnWatchdogTimeout.reason` ('inactivity' | 'cap'), defused abandoned promise; keep the single-`ms` overload
- [x] 1.2 Add `turnInactivityMs` to `ConfigSchema` (default 600000) + `agent/seeds/config.json` untouched (optional knob); thread through `DurableTurnRouter` meta; sharpen the `turnWatchdogMs` doc comment to "hard cap"
- [x] 1.3 Feed activity from `bridgeRunStream`: per-run activity timestamp touched on every chunk read; wire it into the race in `driveTurn`; abandon log includes the fire reason
- [x] 1.4 Unit tests (`turnWatchdog.unit.test.ts`): healthy-past-inactivity-budget survives to cap, true silence fires at inactivity, cap fires while active, overload compatibility

## 2. Dashboard phantom-running fix

- [x] 2.1 `bridgeRunStream` returns a cancel handle (reader.cancel → loop exits → finally settles); track per-run
- [x] 2.2 `abandonHungTurn`: after `run.cancel()`, cancel the bridge and call `bus.finishTurn(runId, 'errored')` directly
- [x] 2.3 Make `LiveBus.finishTurn` idempotent (second settle no-op); unit test both settle orderings
- [x] 2.4 Router test: watchdog abandon → LiveBus entry terminal ('errored'), no leaked bridge

## 3. Instruction improvements

- [x] 3.1 Delegation builtin skill + conversational prompt: many-sequential-tool-call sweeps → delegate to a subagent (brief completely, tell the user it's underway); keep the turn short
- [x] 3.2 Translator compose prompt: past 10 steps since the last update, silence is not acceptable — send one short concrete status; unit test the rule text is present / behavior with high stepsSinceUpdate mock

## 4. Verification

- [x] 4.1 Typecheck + full unit/integration + workflow suites + production build
- [ ] 4.2 (deploy-time — lands at the NEXT devbox restart, deliberately not forced while the owner exercises the live agent) Live smoke: a long multi-step turn survives past 10 minutes while active; a watchdog abandon (forced via tiny turnInactivityMs on a scratch env) settles the dashboard live view
