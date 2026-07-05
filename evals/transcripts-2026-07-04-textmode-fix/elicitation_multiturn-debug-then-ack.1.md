# elicitation/multiturn-debug-then-ack

delivered=text recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] Ah, that's annoying. Can you send me the error message/stack trace it prints when it crashes? Also quick context:
        
        - Node version and OS?
        - Does it crash immediately or after something happens (like a DB connection)?
        - Did it work before and just recently broke, or is this a fresh setup?
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That one's easy — express isn't installed in your node_modules. Just run:
        
        npm install express
        
        If you have a package.json with a bunch of dependencies already (not just express), you can also just run npm install by itself to grab everything listed. And if you don't have a node_modules folder at all yet, that's usually the tell — means npm install never ran after cloning/pulling the project.
        
        Try that and let me know if it starts up.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] Yep, that'll do it — fresh clones never come with node_modules. Just run:
        
        npm install
        
        in the project folder, then npm start (or whatever your start script is) and it should boot up fine.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  → stay_silent()
  [reply] (silence)