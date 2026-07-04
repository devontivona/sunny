# elicitation/multiturn-debug-then-ack

delivered=silence recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] Ugh, annoying. Can you paste the error/stack trace you're seeing? Also quick context:
        
        - how are you starting it (npm start, node file.js, etc)?
        - did it work before and just broke, or is this a fresh setup?
        
        That'll help me pin down what's going on.
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That means express isn't installed in node_modules (or got deleted). Quick fix — run this in your project folder:
        
        npm install express
        
        If you have a package.json with express already listed as a dependency, you can just run:
        
        npm install
        
        That'll pull in everything listed, including express. Then try starting the app again. Let me know if it still fails after that.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] That's exactly it — a fresh clone only has your source code, not node_modules (it's gitignored). Just run:
        
        npm install
        
        in the project root, then start it up again. Should be good to go.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  → stay_silent()