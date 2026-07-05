# elicitation/silence-when-nothing-to-say

delivered=silence recovered=false

USER (Devon): remind me to call mom at 6pm today
ASSISTANT turn:
  → bash({"command":"TZ=America/New_York date +\"%Y-%m-%dT18:00:00\""})
  → schedule_create({"kind":"once","spec":"2026-07-04T18:00:00","label":"call mom","prompt":"Remind Devon to call mom."})
  [reply] Got it — I'll remind you to call mom at 6pm today.
USER (Devon): 👍
ASSISTANT turn:
  → stay_silent()