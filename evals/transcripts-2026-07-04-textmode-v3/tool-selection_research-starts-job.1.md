# tool-selection/research-starts-job

delivered=text recovered=false

USER (Devon): research the best noise-cancelling headphones under $300 and report back
ASSISTANT turn:
  → delegate_task({"task":"Research the best noise-cancelling headphones available for under $300 (current models, as of now). \n\nObjective: Identify the top 3-5 noise-cancelling headphones under $300, considering ANC)
  → bash({"command":"curl -s \"https://www.google.com/search?q=best+noise+cancelling+headphones+under+%24300+2025+wirecutter+rtings\" | head -c 2000"})
  → bash({"command":"curl -s \"https://html.duckduckgo.com/html/?q=best+noise+cancelling+headphones+under+%24300+2025\" -A \"Mozilla/5.0\" | grep -oE '<a[^>]*class=\"result__a\"[^>]*>[^<]*</a>' | head -30"})
  → bash({"command":"curl -sL \"https://www.soundguys.com/best-bluetooth-headphones-under-300-29466/\" -A \"Mozilla/5.0 (Windows NT 10.0; Win64; x64)\" | sed 's/<[^>]*>/ /g' | tr -s ' \\n' ' \\n' | grep -i -A3)
  → bash({"command":"curl -sL \"https://www.google.com/search?q=Sony+WH-1000XM4+price+today+amazon\" -A \"Mozilla/5.0\" -H \"Accept-Language: en-US\" | grep -oE '\\$[0-9]{2,3}\\.[0-9]{2}' | head -5\necho \"---)
  [translator] on it — digging through current noise-cancelling headphones under $300 now
  [reply] Done digging — here's the rundown for noise-cancelling headphones under $300:
        
        1. Sony WH-1000XM4 — MSRP $349 but constantly on sale for $200-280. Still considered best-in-class ANC even next to newer models, excellent sound, super comfortable, 30hr battery. Best overall value if you catch a sale (which is often).
        
        2. Bose QuietComfort 45 — ~$279. Bose's ANC is famously the smoothest/most natural-feeling, great for flights and voice clarity (podcasts/calls), 24hr battery, very comfortable for long wear.
        
        3. Sennheiser Momentum 4 Wireless — MSRP $379 but frequently discounted to $250-280. Best battery life by far (up to 60hrs), excellent detailed sound, solid ANC.
        
        4. Sennheiser Accentum Plus — $230 new. Great value pick: decent ANC, 53hr battery, good sound, EQ app. Doesn't fold flat and no IP rating, but punches above its price.
        
        5. Sony ULT Wear — $200. If you want thumping bass + comfort + decent ANC, this is the pick, though sound is bass-heavy/not neutral.
        
        Top pick: Sony WH-1000XM4. It's a couple years old now but still nails the trifecta — ANC, sound quality, comfort — better than almost anything at this price, and it's basically always available under $300 (often well under). Unless you specifically want Bose's call/voice clarity or Sennheiser's mega battery life, this is the safe best buy.