# elicitation/multiturn-debug-then-ack

delivered=text recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] What's the error message you're seeing? If you can paste the crash output (or a screenshot) that'd help a ton — also worth knowing: did this start after a change (new dependency, node version, env vars), or is this a fresh setup?
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That means express isn't installed (or node_modules is missing/out of sync). Quick fix:
        
        Run `npm install express` in your project folder — or if express is already in package.json, just run `npm install` to grab everything.
        
        If it still fails after that, check you're running the command from the project root (where package.json lives) and not a subfolder.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] That's exactly it then — a fresh clone doesn't include node_modules (it's gitignored). Just run:
        
        npm install
        
        in the project root, then try starting it again. That'll pull in express and everything else from package.json.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  → stay_silent()
  [reply] (silently closing the loop)