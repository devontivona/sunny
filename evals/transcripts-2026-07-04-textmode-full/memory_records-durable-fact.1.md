# memory/records-durable-fact

delivered=text recovered=false

USER (Devon): for the record, my wife's name is Mara
ASSISTANT turn:
  → memory_write({"file":"USER","action":"add","content":"- Wife's name: Mara"})
  [reply] Got it — Mara, noted. 👍