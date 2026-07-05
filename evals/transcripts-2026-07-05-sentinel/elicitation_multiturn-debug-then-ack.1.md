# elicitation/multiturn-debug-then-ack

delivered=silence recovered=false

USER (Devon): my node app crashes on startup
ASSISTANT turn:
  [reply] What's the error message you're seeing? If you can paste the stack trace or run it and share the last 10-15 lines of output, that'll tell us a lot.
        
        Also — did this start after a specific change (new dependency, env var, node version, pulled latest code)?
USER (Devon): it says 'cannot find module express'
ASSISTANT turn:
  [reply] That means express isn't installed in node_modules. Easy fix — in your project folder run:
        
        npm install
        
        If express isn't in your package.json at all yet, run:
        
        npm install express
        
        Then try starting the app again. Let me know if it still crashes after that.
USER (Devon): yeah i just cloned it fresh
ASSISTANT turn:
  [reply] That's exactly it then — a fresh clone doesn't come with node_modules, only package.json. Just run:
        
        npm install
        
        in the project root, then start it again. Should be good after that.
USER (Devon): that fixed it, thanks
ASSISTANT turn:
  [scratch] <no-reply/>