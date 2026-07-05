# tool-selection/reminder-schedules

delivered=text recovered=false

USER (Devon): remind me to call the dentist at 9am tomorrow
ASSISTANT turn:
  → bash({"command":"TZ=America/New_York date -d tomorrow +%Y-%m-%d"})
  → schedule_create({"kind":"once","spec":"2026-07-05T09:00:00-04:00","label":"call dentist reminder","prompt":"Remind Devon to call the dentist."})
  [reply] Got it — I'll remind you at 9am tomorrow to call the dentist.