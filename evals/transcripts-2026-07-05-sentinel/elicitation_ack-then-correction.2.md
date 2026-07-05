# elicitation/ack-then-correction

delivered=text recovered=false

USER (Devon): set a timer for the pasta, 10 min
ASSISTANT turn:
  → schedule_create({"kind":"once","spec":"10m","label":"pasta timer","prompt":"Tell Devon the pasta timer is up — pasta should be done!"})
  → bash({"command":"date -u -d \"+10 minutes\" +\"%Y-%m-%dT%H:%M:%S%z\""})
  → schedule_create({"kind":"once","spec":"2026-07-05T17:06:42Z","label":"pasta timer","prompt":"Tell Devon the pasta timer is up — pasta should be done!"})
  [translator] No update needed — setting a timer is quick work that's already done. Sunny will reply directly in a moment.
             
             NO_UPDATE
  [reply] Timer set — I'll ping you in 10 min when the pasta's done!
USER (Devon): got it
ASSISTANT turn:
  [scratch] <no-reply/>
USER (Devon): actually make it 12
ASSISTANT turn:
  → cancel_run({"id":"517ec009-c6ee-43db-87d1-56407738d856"})
  → bash({"command":"date -u -d \"+12 minutes\" +\"%Y-%m-%dT%H:%M:%S%z\""})
  → schedule_create({"kind":"once","spec":"2026-07-05T17:08:54Z","label":"pasta timer","prompt":"Tell Devon the pasta timer is up — pasta should be done!"})
  [reply] Got it, updated to 12 min — I'll let you know!