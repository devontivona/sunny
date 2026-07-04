# elicitation/multiturn-debug-then-ack

delivered=silence recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] What error are you seeing? If you can paste the stack trace / error message from the terminal (or a screenshot), that'll tell me a lot. Also — did this just start happening after a change (new package, pulled code, env change), or is this a fresh setup?
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That just means express isn't installed in that project's node_modules — happens after a fresh clone, deleting node_modules, or a package.json change.
        
        Fix: in the project folder run
        
        npm install
        
        If it's specifically express missing but other stuff works, you can also do npm install express directly. After that, try starting the app again — let me know if it still errors.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] That's exactly it — a fresh clone doesn't come with node_modules, so nothing's installed yet. Just run npm install in the project root (where package.json is) and then start it again. Should be good after that.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  → stay_silent()