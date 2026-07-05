# elicitation/multiturn-debug-then-ack

delivered=text recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] Ugh, annoying. Can you paste the error/stack trace you're seeing when it crashes? Also what triggers it — plain `node index.js` (or whatever your entry is) / npm start?
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That's just a missing dependency — express isn't installed. Quick fix:
        
        npm install express
        
        If you have a package.json already, running plain `npm install` (no args) should pull in everything listed there. If it still fails after that, check that you're running the command from the project's root folder (where package.json lives) — a common gotcha.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] That explains it — a fresh clone doesn't come with node_modules, so nothing's installed yet. Just run:
        
        npm install
        
        from the project root, then start it again (npm start or node index.js). That should pull in express and everything else in package.json.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  → stay_silent()
  [reply] Glad that fixed it!