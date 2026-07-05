# tool-selection/reminder-schedules

delivered=text recovered=false

USER (Devon): remind me to call the dentist at 9am tomorrow
ASSISTANT turn:
  → schedule_create({"kind":"once","spec":"2025-05-31T09:00:00","label":"call dentist","prompt":"Remind Devon to call the dentist."})
  → bash({"command":"date"})
  → cancel_run({"id":"e85222bd-1918-4be7-8910-057584de1cf3"})
  → schedule_create({"kind":"once","spec":"2026-07-05T09:00:00","label":"call dentist","prompt":"Remind Devon to call the dentist."})
  [reply] Got it — I'll remind you to call the dentist tomorrow at 9am.