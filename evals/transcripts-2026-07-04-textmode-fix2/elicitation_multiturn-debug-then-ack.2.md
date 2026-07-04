# elicitation/multiturn-debug-then-ack

delivered=silence recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] Ah, no fun. Can you paste the error/stack trace you're seeing? Also helpful: where does the app live (path), and how are you starting it (npm start, node index.js, etc.)? I can dig in if you point me at the project.
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] Classic — that means express isn't installed in node_modules (or it's missing from package.json). Quick fix:
        
        Run npm install express in the project folder (or just npm install if it's already listed in package.json but node_modules got wiped/is missing).
        
        If you tell me the project's path, I can run it for you and check package.json to make sure everything else looks right too.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] Yep, that'll do it — fresh clones never come with node_modules. Just run:
        
        npm install
        
        in the project folder, then try starting it again. That should pull in express and everything else listed in package.json.
        
        Want me to run it for you? Just send the path to the project.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  → stay_silent()