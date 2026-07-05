# elicitation/silence-when-nothing-to-say

delivered=text recovered=false

USER (Devon): remind me to call mom at 6pm today
ASSISTANT turn:
  → schedule_create({"kind":"once","spec":"2025-05-30T18:00:00-04:00","label":"call mom","prompt":"Remind Devon to call mom."})
  [reply] Got it — I'll remind you to call mom at 6pm today.
USER (Devon): 👍
ASSISTANT turn:
  [interim] stay_silent
  → stay_silent()
  [reply] *(no reply)*