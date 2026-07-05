# elicitation/ack-then-correction

delivered=text recovered=false

USER (Devon): set a timer for the pasta, 10 min
ASSISTANT turn:
  → schedule_create({"kind":"once","spec":"PT10M","label":"pasta timer","prompt":"Tell Devon the pasta timer is up — pasta should be done!"})
  → bash({"command":"date -u -d '+10 minutes' +\"%Y-%m-%dT%H:%M:%S%z\""})
  → schedule_create({"kind":"once","spec":"2026-07-04T21:10:21+00:00","label":"pasta timer","prompt":"Tell Devon the pasta timer is up — pasta should be done!"})
  [reply] Timer set — I'll ping you in 10 min when the pasta's done 🍝
USER (Devon): got it
ASSISTANT turn:
  [scratch] stay_silent
  → stay_silent()
USER (Devon): actually make it 12
ASSISTANT turn:
  → cancel_run({"id":"5e3e55b9-378f-43b4-864f-05d5c32933c4"})
  → bash({"command":"date -u -d '+12 minutes' +\"%Y-%m-%dT%H:%M:%S%z\""})
  → schedule_create({"kind":"once","spec":"2026-07-04T21:12:32+00:00","label":"pasta timer","prompt":"Tell Devon the pasta timer is up — pasta should be done!"})
  [reply] Got it, updated to 12 min.