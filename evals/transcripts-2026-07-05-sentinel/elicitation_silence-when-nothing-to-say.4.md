# elicitation/silence-when-nothing-to-say

delivered=silence recovered=false

USER (Devon): remind me to call mom at 6pm today
ASSISTANT turn:
  → schedule_create({"kind":"once","spec":"2025-01-01T18:00:00","label":"call mom reminder","prompt":"Remind Devon to call mom."})
  → bash({"command":"date"})
  → cancel_run({"id":"0b1451a3-8783-406b-bba0-96102f840da4"})
  → schedule_create({"kind":"once","spec":"2026-07-05T22:00:00Z","label":"call mom reminder","prompt":"Remind Devon to call mom."})
  [reply] Got it — I'll remind you to call mom at 6pm today.
USER (Devon): 👍
ASSISTANT turn:
  [scratch] <no-reply/>