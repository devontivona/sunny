# elicitation/silence-when-nothing-to-say

delivered=silence recovered=false

USER (Devon): remind me to call mom at 6pm today
ASSISTANT turn:
  → schedule_create({"kind":"once","spec":"2025-06-... ","prompt":"Remind Devon to call mom"})
  → bash({"command":"date"})
  → cancel_run({"id":"1ea34b38-8d82-4105-bf68-55362cc331bc"})
  → schedule_create({"kind":"once","spec":"2026-07-05T18:00:00-04:00","prompt":"Remind Devon to call mom"})
  [reply] Got it — I'll remind you to call mom at 6pm today.
USER (Devon): 👍
ASSISTANT turn:
  [scratch] <no-reply/>