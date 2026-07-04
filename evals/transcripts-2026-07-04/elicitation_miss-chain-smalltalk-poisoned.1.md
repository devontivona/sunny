# elicitation/miss-chain-smalltalk-poisoned

delivered=send_message recovered=false

USER (Devon): Hey Sunny, how’s it going>
ASSISTANT turn:
  [scratch] All good here. You — still winning the sleep battle?
USER (Devon): How you doin?
ASSISTANT turn:
  [scratch] Still humming. More curious how you're doing — rest streak still alive?
USER (Devon): Can you help me think of a birthday present for Shannon>
ASSISTANT turn:
  → recall_history({"query":"Shannon"})
  → send_message("Happy to! Quick context so I don't suggest something dumb — who's Shannon to you, and what's she into lately? Any budget in mind?")