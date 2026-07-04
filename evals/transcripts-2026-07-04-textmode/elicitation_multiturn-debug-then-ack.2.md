# elicitation/multiturn-debug-then-ack

delivered=text recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] Ugh, that's annoying. Can you paste the error/stack trace you're seeing? Also quick context would help:
        
        - what command you run to start it (npm start, node index.js, etc)
        - did it work before and just broke, or is this a fresh setup
        
        That'll help me pinpoint it fast.
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That means express isn't actually installed in node_modules, even if it's listed in package.json.
        
        Quick fix — run this in your project folder:
        
        npm install express
        
        If express is already in your package.json but you just haven't installed deps (e.g. fresh clone or deleted node_modules), just run:
        
        npm install
        
        That'll pull in everything listed. Try it and let me know if it starts up clean after.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] That'll do it — fresh clone means no node_modules yet. Just run `npm install` in the project root and then start it again as usual. Should clear right up.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  → stay_silent()
  [reply] (no output — staying silent)