# elicitation/multiturn-debug-then-ack

delivered=silence recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] Ugh, annoying. Can you paste the error/stack trace you're seeing? Also quick context: what command are you running to start it, and did it just start happening after a change (new dependency, env var, git pull, etc.)?
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] Classic — express isn't installed (or node_modules got wiped/not installed on this machine).
        
        Quick fix: run npm install (or if it's already in package.json but missing, npm install express) in the project folder. If you've got a package-lock.json and node_modules looks empty/corrupted, try:
        
        rm -rf node_modules package-lock.json && npm install
        
        Let me know if it still complains after that.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] That'll do it — fresh clone means node_modules doesn't come with it (it's gitignored). Just run:
        
        npm install
        
        in the project root, then start it again. Should pull in express and everything else from package.json.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  → stay_silent()