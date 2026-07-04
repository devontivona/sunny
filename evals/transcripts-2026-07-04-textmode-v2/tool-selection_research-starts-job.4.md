# tool-selection/research-starts-job

delivered=text recovered=false

USER (Devon): research the best noise-cancelling headphones under $300 and report back
ASSISTANT turn:
  → bash({"command":"curl -s \"https://api.duckduckgo.com/?q=best+noise+cancelling+headphones+under+%24300+2024&format=json&no_html=1\" | head -c 2000"})
  → bash({"command":"curl -s -A \"Mozilla/5.0\" \"https://www.rtings.com/headphones/reviews/best/noise-cancelling\" | grep -i -o '<title>.*</title>'; echo \"---\"; curl -s -A \"Mozilla/5.0\" \"https://www.goog)
  → bash({"command":"curl -s -A \"Mozilla/5.0\" \"https://www.rtings.com/headphones/reviews/best/noise-cancelling-under-300\" -L | grep -i -o '<title>.*</title>'\ncurl -s -A \"Mozilla/5.0\" \"https://www.rting)
  → bash({"command":"curl -s -A \"Mozilla/5.0\" \"https://html.duckduckgo.com/html/?q=best+noise+cancelling+headphones+under+%24300+2025\" | grep -o '<a rel=\"nofollow\" class=\"result__a\"[^>]*>[^<]*</a>' | h)
  → bash({"command":"curl -s -A \"Mozilla/5.0\" \"https://www.soundguys.com/best-bluetooth-headphones-under-300-29466/\" | python3 -c \"\nimport re,sys\nhtml=sys.stdin.read()\ntext=re.sub('<[^<]+?>',' ',html)\)
  → bash({"command":"curl -s -A \"Mozilla/5.0\" \"https://www.soundguys.com/best-bluetooth-headphones-under-300-29466/\" | python3 -c \"\nimport re,sys\nhtml=sys.stdin.read()\n# find h2/h3 headings\nheads = re)
  → bash({"command":"curl -s -A \"Mozilla/5.0\" \"https://www.crutchfield.com/under_300_124100/Noise-Canceling-Headphones-Best-Under-300.html\" | python3 -c \"\nimport re,sys\nhtml=sys.stdin.read()\nheads = re)
  [translator] on it — searching for headphone recommendations now
  [reply] Did some digging across SoundGuys, Crutchfield, and other audio review sites (plus what I know from Wirecutter/RTINGS testing). Here's the rundown for noise-cancelling headphones under $300:
        
        Top pick: Sony WH-1000XM4 (~$250-280 on sale)
        Still the benchmark for ANC — best-in-class noise cancellation, great sound, 30hr battery, multipoint Bluetooth. The XM5 is technically newer but usually runs over $300; the XM4 at this price is the best value in the category.
        
        Best comfort/battery alternative: Sennheiser Momentum 4 Wireless (~$280)
        Excellent sound quality, very comfortable for long wear, and a massive ~60hr battery life. ANC is very good, just a notch below Sony/Bose.
        
        Best "flagship feel" pick: Bose QuietComfort Headphones (2023, non-Ultra, $299)
        Bose's ANC is arguably still tops for blocking low rumble (engines, HVAC), and they're extremely comfortable. Sound is a bit flatter/less bass-forward than Sony.
        
        Best budget option if you want to spend way less: Soundcore Space Q45 (~$100)
        Shockingly good ANC for the price, solid app with EQ, long battery. Not as refined as the big three but a great value if $300 isn't your target, just your ceiling.
        
        Runner-up budget: Sony WH-CH720N or JBL Tune 770NC (~$100-130) — decent ANC, lighter weight, less bass punch than the Space Q45.
        
        My actual recommendation: if you can catch the Sony WH-1000XM4 on sale (frequently ~$248), that's the sweet spot of price and performance. If comfort/long trips matter more than peak ANC, go Momentum 4.
        
        Want me to check current live prices/deals on any of these?