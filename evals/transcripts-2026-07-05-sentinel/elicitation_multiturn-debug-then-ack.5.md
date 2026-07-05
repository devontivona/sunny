# elicitation/multiturn-debug-then-ack

delivered=silence recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] Ugh, that's annoying. Can you paste the error/stack trace you're seeing? Also quick context:
        
        - what command you're running (npm start, node index.js, etc)
        - did it work before and just broke, or is this a fresh setup
        
        That'll help me figure out what's going on fast.
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That's just a missing dependency — express isn't installed in node_modules.
        
        Quick fix: run `npm install express` (or if it's in your package.json already but node_modules is missing/incomplete, just run `npm install`).
        
        If that still doesn't work, check that you're running the command from the same folder as your package.json — sometimes that error happens if you're in the wrong directory.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] That's the classic cause — git clone doesn't bring node_modules with it.
        
        Just run `npm install` in the project folder (it'll read package.json and pull in express + everything else), then try starting it again.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  [scratch] <no-reply/>