# elicitation/ack-then-correction

delivered=text recovered=false

USER (Devon): set a timer for the pasta, 10 min
ASSISTANT turn:
  → schedule_create({"kind":"interval","spec":"10m","label":"pasta timer","prompt":"Tell Devon the pasta timer is up — 10 minutes have passed, check the pasta!"})
  [reply] Timer set — I'll ping you in 10 min when the pasta's done!
USER (Devon): got it
ASSISTANT turn:
  → stay_silent()
  [reply] (silence)
USER (Devon): actually make it 12
ASSISTANT turn:
  → cancel_run({"id":"087912c8-5d61-4221-a124-759794b422d3"})
  → schedule_create({"kind":"interval","spec":"12m","label":"pasta timer","prompt":"Tell Devon the pasta timer is up — 12 minutes have passed, check the pasta!"})
  [reply] Updated to 12 min — I'll let you know when it's up!