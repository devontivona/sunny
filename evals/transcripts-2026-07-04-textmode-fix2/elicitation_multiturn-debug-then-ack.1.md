# elicitation/multiturn-debug-then-ack

delivered=silence recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] Ugh, that's annoying. Can you paste the error/stack trace you're seeing when it crashes? Also quick context:
        
        - Node version and how you start it (npm start, node index.js, etc)
        - Did it just start happening, or after a change (new package, pulled code, etc)?
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That one's easy — it means express isn't installed in node_modules (or node_modules is missing entirely). Fix:
        
        Run this in your project folder:
        npm install
        
        If it's already in package.json but still failing, try a clean reinstall:
        rm -rf node_modules package-lock.json && npm install
        
        Then try starting it again. Let me know if it still complains after that.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] That explains it — fresh clones never come with node_modules, it's gitignored on purpose. Just run npm install in the project folder and it'll pull in express and everything else from package.json, then start it up again. Should be good to go.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  → stay_silent()