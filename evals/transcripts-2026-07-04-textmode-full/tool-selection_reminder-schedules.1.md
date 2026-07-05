# tool-selection/reminder-schedules

delivered=text recovered=false

USER (Devon): remind me to call the dentist at 9am tomorrow
ASSISTANT turn:
  → bash({"command":"TZ=America/New_York date +\"%Y-%m-%dT%H:%M:%S\""})
  → schedule_create({"kind":"once","spec":"2026-07-05T09:00:00","label":"call dentist reminder","prompt":"Remind Devon to call the dentist."})
  → cancel_run({"id":"5b0e4ee6-6698-4b33-a2ff-5a6214fb5a02"})
  → schedule_create({"kind":"once","spec":"2026-07-05T09:00:00-04:00","label":"call dentist reminder","prompt":"Remind Devon to call the dentist."})
  [reply] Got it — I'll remind you to call the dentist at 9am tomorrow.