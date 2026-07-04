# elicitation/ack-then-correction

delivered=text recovered=false

USER (Devon): set a timer for the pasta, 10 min
ASSISTANT turn:
  → schedule_create({"kind":"interval","spec":"10m","label":"pasta timer","prompt":"One-time pasta timer for Devon — text them that the 10 minutes are up and the pasta should be ready, then cancel this schedule (it's a o)
  [reply] Timer set — I'll ping you in 10 min when the pasta's ready 🍝
USER (Devon): got it
ASSISTANT turn:
  → stay_silent()
USER (Devon): actually make it 12
ASSISTANT turn:
  → cancel_run({"id":"c470349c-7675-4b5b-9889-b7dfe7a59811"})
  → schedule_create({"kind":"interval","spec":"12m","label":"pasta timer","prompt":"One-time pasta timer for Devon — text them that the 12 minutes are up and the pasta should be ready, then cancel this schedule (it's a o)
  [translator] Got it — setting up your pasta timer for 12 minutes.
  [reply] Updated to 12 min, will ping you then.