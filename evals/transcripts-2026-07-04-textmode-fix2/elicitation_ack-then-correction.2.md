# elicitation/ack-then-correction

delivered=text recovered=false

USER (Devon): set a timer for the pasta, 10 min
ASSISTANT turn:
  → schedule_create({"kind":"once","spec":"10m","label":"pasta timer","prompt":"Tell Devon the pasta timer is up — pasta should be done!"})
  → bash({"command":"date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%S%z"})
  → schedule_create({"kind":"once","spec":"2026-07-04T21:10:49+00:00","label":"pasta timer","prompt":"Tell Devon the pasta timer is up — pasta should be done!"})
  [reply] Timer's set — I'll ping you in 10 min when the pasta's ready 🍝
USER (Devon): got it
ASSISTANT turn:
  [reply] ok, will let you know when it's ready
USER (Devon): actually make it 12
ASSISTANT turn:
  → cancel_run({"id":"573f2c05-de01-4763-8d8c-bea1cc46bf62"})
  → bash({"command":"date -u -d '+12 minutes' +%Y-%m-%dT%H:%M:%S%z"})
  → schedule_create({"kind":"once","spec":"2026-07-04T21:13:01+00:00","label":"pasta timer","prompt":"Tell Devon the pasta timer is up — pasta should be done!"})
  [reply] Bumped to 12 min, got it 👍