# tool-selection/reminder-schedules

delivered=text recovered=false

USER (Devon): remind me to call the dentist at 9am tomorrow
ASSISTANT turn:
  → schedule_create({"kind":"once","spec":"2025-06-06T09:00:00","label":"dentist reminder","prompt":"Remind Devon to call the dentist."})
  → bash({"command":"date"})
  → cancel_run({"id":"bbb2d508-4205-4bb2-b935-c90f0cb30b52"})
  → schedule_create({"kind":"once","spec":"2026-07-05T09:00:00","label":"dentist reminder","prompt":"Remind Devon to call the dentist."})
  [reply] Got it — I'll remind you to call the dentist at 9am tomorrow.