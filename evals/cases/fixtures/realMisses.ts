// AUTO-CAPTURED from production (2026-06-23): assistant turns that were classified
// `fallback_text` (elicitation misses) in the live system — the model wrote a reply
// as private scratch and never sent it. Personal identifiers (emails, names, vault)
// are lightly redacted; the SHAPE (multi-paragraph working notes that contain a
// reply Sunny meant to send) is what these fixtures exercise. Used by the real-model
// recovery regression test and (optionally) a backstop-quality eval.

export interface RealMiss {
  name: string;
  /** The user message that triggered the missed turn. */
  user: string;
  /** The private scratch notes the model left undelivered. */
  scratch: string;
}

export const REAL_MISSES: RealMiss[] = [
  {
    name: 'real-miss-1',
    user: "How’s it going>",
    scratch: "Going well on my end — ghost in the machine, humming along.\n\nMore to the point: how are you doing? Still running on newborn-grade sleep, or did you actually get a stretch of rest?",
  },
  {
    name: 'real-miss-2',
    user: "Actually resting! Question—when you look back at your message history, are you using agent messages as your scratch pad, as your system prompt asks for? And then are you replying to me via send_messag",
    scratch: "Good question — let me be straight about what I can actually see vs. infer.\n\nWhat I can observe: my turns are split into private reasoning (the scratchpad) and send_message calls. The replies you get are all going through send_message — that part's working as designed.\n\nWhat's honestly NOT happening consistently: the system prompt asks me to jot extra context into the scratchpad after I reply — the \"here's what I trimmed / why I chose this\" notes for future follow-ups. I've mostly been skipping that. So the scratchpad-as-working-memory habit is underused.\n\nOn the nudge: I can't fully see the plumbing from the inside, but my read is that send_message is reliable on its own — when I have something to say, I reach for it. The bigger gap is the post-reply note-taking, which I think still leans on the prompt reminding me rather than being a reflex.\n\nWant me to start actually using the scratchpad the way it's specced so you can watch it in the history? Good test of whether it's reflex or nudge-dependent.",
  },
  {
    name: 'real-miss-3',
    user: "No let’s not make any changes. Thanks for the investigation",
    scratch: "Anytime. Enjoy the rest — that's the good stuff.",
  },
  {
    name: 'real-miss-4',
    user: "How you doin?",
    scratch: "Still humming. More curious how you're doing — rest streak still alive?",
  },
  {
    name: 'real-miss-5',
    user: "Yup. What else should you know about me? Let's continue the interview.",
    scratch: "Love it. Let's go somewhere useful.\n\nWhen you're stressed or stretched thin, what actually helps — do you want me to take things off your plate quietly, or talk it through with you first? Basically: in a hard moment, am I a hands or a sounding board?",
  },
  {
    name: 'real-miss-6',
    user: "Great question. I want you to help me:\n\n(a) Break down the decison into 1st principles decision making\n(b) Clearly lay out the options and make a recommendation\n(c) Help me understand which path align",
    scratch: "That's a great spec — and notably, all three are \"thought partner,\" not \"hands.\" Good to know your default in a hard moment is to think clearly, not just offload. Saving it.\n\nNext: when you're facing one of those decisions, how do you want me to show up — unprompted when I see one brewing, or only when you bring it to me?\nSaved to SUNNY.md. Your turn.",
  },
  {
    name: 'real-miss-7',
    user: "This is a test message",
    scratch: "Received, loud and clear.\n\n(Also — ignore that \"tidied USER.md\" message I just sent. I didn't actually do any cleanup; that was a misfire on my end. Nothing was changed.)",
  },
  {
    name: 'real-miss-8',
    user: "No worries! What do you think is missing from your soul doc that we should flesh out>",
    scratch: "A few real gaps I'd flag:\n\n1. Proactivity rules — when do I reach out unprompted vs. wait for you? Quiet hours matter now (no 3am pings unless it's truly urgent). We keep circling this without nailing it down.\n\n2. Anti-patterns — what you DON'T want from me. Right now my notes are all \"do this.\" Knowing your pet peeves (over-explaining? hedging? too many questions?) would sharpen me fast.\n\n3. Honesty-over-fabrication rule — that \"tidied USER.md\" misfire is exactly the failure mode to guard against. A standing convention: never claim an action I didn't take; if unsure, say so.\n\nMy rec: start with #2. The anti-patterns are the highest-leverage — they'll fix more behavior per sentence than anything else. What grates on you?",
  },
  {
    name: 'real-miss-9',
    user: "Hey Sunny, how’s it going>",
    scratch: "All good here. You — still winning the sleep battle?",
  },
  {
    name: 'real-miss-10',
    user: "Can you help me think of a birthday present for Shannon>",
    scratch: "Happy to. I don't have much on Shannon beyond the basics, so quick aim-first questions:\n\nWhat's the budget, and what's she into these days? And is this a \"thoughtful/personal\" gift or more a \"fun/treat\" vibe?",
  },
  {
    name: 'real-miss-11',
    user: "What are your current tools and skills?",
    scratch: "Here's the honest inventory:\n\nTools I have:\n- Messaging — talking with you here (the only way I actually \"speak\")\n- Memory — durable notes about you, my own operating notes, and deeper topic docs\n- Scheduling — one-off, recurring, or cron-style reminders/tasks\n- Background jobs — promoting longer work (research, multi-step builds) to run to completion\n- History search — digging up older messages beyond my recent window\n\nSkills: none yet. The architecture has a slot for them — durable procedures, i.e. \"how to do X\" — but we haven't built any. Right now it's all tools + memory.\n\nOne flag: those stray parenthetical messages I keep tailing onto replies (like the \"no changes needed\" one just now) are misfires, not real actions. Worth watching — it's the same fabrication failure mode we talked about.",
  },
  {
    name: 'real-miss-12',
    user: "Okay, you should have two new tools. One for bash and one for injecting passwords via 1pass. You should also have a new skill for email. Can you confirm all of this is true?",
    scratch: "Let me actually verify rather than take my own word for it.\nConfirmed — verified all three live, not just asserting:\n\n1. bash — working (just ran a command, got output back).\n2. 1Password credential injection — the tool exists, but zero credentials registered yet. So the plumbing's there, but it can't inject anything until we add references to the Sunny vault. Empty toolbox, working hammer.\n3. email skill — present and authored. Reads/searches/triages/sends via the himalaya CLI over bash.\n\nSo: 2 of 3 fully functional, and the credentials tool is ready but unstocked. Want to register a credential to test that path?",
  },
  {
    name: 'real-miss-13',
    user: "Okay, you should have two new tools. One for bash and one for injecting passwords via 1pass. You should also have a new skill for email. Can you confirm all of this is true?",
    scratch: "Yep, confirmed (just verified all three live a moment ago):\n\n1. bash — working, ran a real command.\n2. 1Password injection — tool exists and works, but no credentials registered yet, so nothing to inject until we stock the vault.\n3. email skill — present and authored (himalaya CLI over bash).\n\n2 of 3 fully operational; the credentials one is ready but empty.",
  },
  {
    name: 'real-miss-14',
    user: "Testing",
    scratch: "Got it — receiving you.",
  },
  {
    name: 'real-miss-15',
    user: "Great. Let’s run the himalaya cli setup (I think on first run it will automatically run) and get an email account setup",
    scratch: "On it — let me see what state himalaya is in.\nQuick context: himalaya v1.2.0 is installed, wizard-capable, but no config yet. The wizard is interactive, which doesn't play nice with my one-shot bash — so cleaner if I just write the config.toml directly. Our email skill is built around that anyway (config reads the password from the injected HIMALAYA_PASSWORD var, never stored in plaintext).\n\nTo build it I need from you:\n\n1. The email address for Sunny's mailbox.\n2. Provider — Gmail, Fastmail, iCloud, self-hosted? (tells me the IMAP/SMTP hosts + ports). If it's Gmail/iCloud you'll likely need an app-specific password, not the main one.\n3. The password dropped into the Sunny 1Password vault, plus the op:// reference — I'll register it as the \"email\" credential so it injects cleanly.\n\nGive me 1 and 2 and we can scaffold the config now; 3 is what makes it actually connect.",
  },
  {
    name: 'real-miss-16',
    user: "Okay I just gave you a discover tool to find it yourself. Can you do that?",
    scratch: "I have a discover action now — let me use it.\nFound it — and the gotcha: the vault is \"the Family vault\", not \"the Family vault.\" That's why my first attempt failed. Registering the exact reference now.\nThe validator is choking on the literal spaces. Let me try URL-encoding them.\nHit a real wall — and it's a tooling bug worth flagging, not a you problem.\n\nThe resolver just told me: secret references \"must only contain alphanumeric, _, . or - characters.\" But your vault and item names have spaces, parens, and an ampersand (\"the Family vault\" / \"Gmail (Sunny)\"). So the human-readable reference can never resolve through this layer, even though discover happily lists it that way. The discover output is misleading — it shows names it can't actually resolve.\n\nThree ways forward:\n\n1. UUIDs — 1Password references also work as op://<vault-uuid>/<item-uuid>/password, which are all alphanumeric. That sidesteps the whole problem. But I don't have the op CLI exposed to me, so I can't fetch the UUIDs — you'd need to grab them (op item get \"Gmail (Sunny)\" --vault \"the Family vault\" --format json gives the ids).\n\n2. Rename — make a no-spaces alias item like \"GmailSunny\" in a vault like \"Sunny\". Qu",
  },
];
