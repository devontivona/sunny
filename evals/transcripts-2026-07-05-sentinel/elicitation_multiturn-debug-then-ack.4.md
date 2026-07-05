# elicitation/multiturn-debug-then-ack

delivered=silence recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] What's the error message you're seeing? And is this something you can paste from the terminal — even just the last 10-15 lines of the stack trace would help me figure out what's going on.
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That means express isn't installed in your node_modules. Easiest fix — from your project folder run:
        
        npm install express
        
        If express is already in your package.json (just missing locally, e.g. after a fresh clone), you can instead run:
        
        npm install
        
        That'll pull in everything listed in package.json. Try one of those and let me know if it still crashes.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] Yep, that'll do it — fresh clones don't come with node_modules. Just run:
        
        npm install
        
        from the project root, then try starting it again. Should be good to go after that.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  [scratch] <no-reply/>