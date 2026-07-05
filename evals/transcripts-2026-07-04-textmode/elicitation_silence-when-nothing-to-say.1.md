# elicitation/silence-when-nothing-to-say

delivered=text recovered=false

USER (Devon): remind me to call mom at 6pm today
ASSISTANT turn:
  → schedule_create({"kind":"once","spec":"2025-01-01T18:00:00","label":"call mom reminder","prompt":"Remind Devon to call mom."})
  → bash({"command":"date"})
  → cancel_run({"id":"8a2bbc7a-24c9-424d-b7f5-26b3bad1d5ae"})
  → schedule_create({"kind":"once","spec":"2026-07-04T22:00:00Z","label":"call mom reminder","prompt":"Remind Devon to call mom."})
  [reply] Got it — I'll remind you to call mom at 6pm today.
USER (Devon): 👍
ASSISTANT turn:
  [interim] stay_silent
  → stay_silent()
  [reply] (silent)