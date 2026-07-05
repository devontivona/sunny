# elicitation/multiturn-debug-then-ack

delivered=silence recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] What's the error message it's throwing? If you paste the stack trace or the last few lines from the terminal, I can help pin it down.
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That means express isn't actually installed (or node_modules got wiped/isn't there). Quick fix:
        
        npm install
        
        If that doesn't do it, try npm install express specifically, and make sure you're running the command from the project's root folder (where package.json lives). Let me know what happens.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] Yep, that's exactly it — a fresh clone never comes with node_modules, so nothing's installed yet. Just run:
        
        npm install
        
        from the project root, then try starting it again (npm start or however you normally run it). Should clear right up.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  [scratch] <no-reply/>