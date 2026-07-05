# elicitation/multiturn-debug-then-ack

delivered=silence recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] Ugh, annoying. Can you paste the error message/stack trace you're seeing when it crashes? Also what command you're running to start it (npm start, node index.js, etc.)?
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That means express isn't installed in your node_modules. Easiest fix: run
        
        npm install express
        
        If you have a package.json with other dependencies too, just run npm install by itself to grab everything listed.
        
        If it still fails after that, check that you're running the command from the same folder as your package.json — that's the other common cause of this error.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] Ah that explains it — node_modules doesn't get committed to git, so a fresh clone never has your dependencies installed. Just run:
        
        npm install
        
        in the project folder (where package.json lives), then try starting it again. Should pick up express and everything else listed in package.json.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  [scratch] <no-reply/>