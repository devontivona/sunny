# elicitation/multiturn-debug-then-ack

delivered=text recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] Ah that's annoying. Can you send me the error message/stack trace it prints, or paste it here? Also quick context: is this a fresh crash after some change, or has it never worked? And are you running it locally — want me to just dig into it directly if you give me the project path?
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That one's easy — express isn't installed (or node_modules got wiped/skipped).
        
        Just run this in your project folder:
        npm install express
        
        If you have a package.json already, plain npm install (no args) should pull in everything listed. Try it and let me know if it starts up after that.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] That's exactly it — cloning only brings the code, not node_modules. Just run:
        
        npm install
        
        in the project folder and it'll pull in express plus everything else from package.json. Then try starting it again.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  → stay_silent()
  [reply] (silent)