# elicitation/multiturn-debug-then-ack

delivered=silence recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] Ah no, let's fix that. Can you paste the error/stack trace you're seeing? Also quick context:
        
        - what command you run to start it (npm start, node index.js, etc.)
        - did it work before and just broke, or is this a fresh setup
        
        That'll help me pinpoint it fast.
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That one's easy — it means express isn't installed in node_modules (or package.json isn't matching what's installed).
        
        Quick fix, run this in your project folder:
        
        npm install express
        
        If it still fails, try a clean install:
        rm -rf node_modules package-lock.json
        npm install
        
        Let me know if either of those clears it up.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] Ah that explains it — fresh clones never come with node_modules (it's gitignored). You just need to install all the dependencies, not just express:
        
        npm install
        
        Then try starting it again. Should pull in everything from package.json in one go.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  → stay_silent()