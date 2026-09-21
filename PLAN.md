# Kotoba 言葉 — design plan

**A 1:1 AI Japanese tutor that runs as a single Cloudflare Worker.**

The AI designs the sessions. The app provides the tools. Nobody has to sit through
another multiple-choice column: the model decides *what you should do next* from a
kit of sixteen activities, then hands you the right instrument for each one.

Status: **working prototype.** Backend, curriculum, session engine, placement
instrument, scripted tutor and SPA are implemented and running under `wrangler dev`.
Model-backed paths (Gemini 3.8 interactions, Live voice) are wired but need a key to
exercise — they have never been run against the live API from this sandbox. See
*Honest status* at the end.

---

## 1. Why this shape

Three research findings drive nearly every decision here.

**One. Comprehensible input has a number, and it is 95–98%.** Laufer, Nation and
Schmitt converge on 95% known words as the floor for comprehension and 98% for
comfortable incidental vocabulary gain. An LLM that *generates the reading material*
can hit that number on purpose, which no fixed textbook can, because it knows which
words this learner has already met. So: every generated passage carries a target
known-ratio, and the passage is only shipped once it measures up.

**Two. Dialogic feedback beats monologic feedback.** A 2026 RECALL study of AI
feedback in speaking found dialogic feedback (where the learner is asked to notice and
self-repair) outperformed one-way scored feedback on both proficiency *and* feedback
literacy. One-way "here is your error" scoring — the ELSA pattern — produced weaker
gains and passive uptake. So Kotoba's heartbeat is not a marked-up correction dump; it
is a question: *「この動詞のて-form、どうなりますか？」* — here is what I heard, what do
you think it should be? The proper correction waits behind a "show me" tap.

**Three. Learners quit because of affect, not difficulty.** High filter, no agency,
and rabbit-hole grammar explainers are the churn mechanism. So the app must expose
what a human tutor reads off your face: *too hard / too easy / boring / I'm lost*, one
tap each, mid-beat, feeding the planner.

Everything else follows from "what would a good private tutor do that an app
structurally cannot?" — and then making the app do exactly that.

---

## 2. The five-minute tour

```
        ┌──────────────────────── Kotoba ────────────────────────┐
        │                                                        │
  Onboarding ──▶ Learner model ──▶ Planner ──▶ Session (16 tools)│
  12 stages       evidence +        Gemini 3.8    conversation,   │
  (adaptive)      confidence        designs the   quiz, reading,  │
        ▲          ▲                next hour     listening, kanji│
        │          │                     │         lab, shadowing,│
        │          │                     ▼         roleplay, ...   │
        │          │              Adaptation ◀── events            │
        │          │           (harder / easier / inject / wrap)   │
        │          │                     │                         │
        └──────────┴── Debrief + SRS cards + error log ◀───────────┘
```

- **Onboarding** measures, it does not ask you to rate yourself. Kana timing, an
  adaptive vocab staircase, grammar, timed reading, listening at two speeds, three
  spoken probes, two written probes, a live interview, then a profile *with error bars*
  that you are invited to argue with.
- **Each session** is a plan: 1–8 beats, each with a stated objective, a reason, the
  target items, a success criterion, and its own tool.
- **Mid-session**, events stream to the planner. Struggle twice on the same grammar
  point and a five-minute scaffolded mini-beat is spliced in after the current one.
  Cruise through it and the tail of the session is rewritten around harder material.
- **Afterwards**, a debrief: what actually improved, up to three things to fix with the
  elicitation question attached, new flashcards scheduled, and one sentence about what
  is coming tomorrow.
- **Tomorrow's preview** is generated in the background by a DO alarm, so the app can
  say "tomorrow: 8 minutes of listening, because your listening lags your reading" and
  mean it.

---

## 3. The sixteen tools

The AI composes from these; each is a real activity with its own contract, not a chat
wrapper. Marking strategy in brackets.

| Tool | What it does | Marking |
|---|---|---|
| `warmup` | Retrieval of what is *due* to be forgotten | deterministic |
| `quiz` | Generated items: particle gaps, readings, forms | deterministic |
| `reading` | Passage at 95–98% known, tap-to-gloss, furigana | deterministic |
| `listening` | Clips at two speeds + dictation | deterministic |
| `kanji_lab` | Component decomposition, readings in context, mnemonics | deterministic |
| `shadowing` | Listen → repeat → compare against your own recording | rubric |
| `pronunciation` | Pitch-accent contour, mora timing, minimal pairs | rubric |
| `grammar_focus` | Notice → discover → explain, never explain-first | deterministic |
| `translation` | JA↔EN with meaning-preserving alternatives | rubric |
| `register` | Casual / polite / honorific / humble transformation | rubric |
| `open_ended` | Free production against a rubric, content-first | rubric |
| `conversation` | Scripted scenario with a goal and escape hatches | conversational |
| `roleplay` | You have a job to do (complain, book, apologise) | rubric |
| `free_talk` | Unscripted, for fluency and nerve | conversational |
| `story` | Graded collaborative story, built from your own vocab | none |
| `recap` | Session debrief and next-step promise | none |

Marking splits 6 deterministic / 6 rubric / 2 conversational / 2 none — which is a
claim about honesty as much as engineering. A machine can mark a particle; it cannot
mark an apology. The rubric tools are graded against stated criteria and shown *with*
those criteria; the two "none" tools are not marked at all, because grading an
unscripted chat would teach the learner to perform for the grader.

Every beat carries the same control rail, which is where the human-tutor feel actually
lives:

- a **six-way rating** — *too easy · just right · too hard · I'm lost · boring · more
  like this* — streamed to the planner mid-session, not a post-session survey;
- an **honest "I don't know"** on every placement item, with the reading available on
  request. Forced guessing measures guess rate, not vocabulary, and it punishes the
  cautious learner who is exactly the person a placement test should be careful with;
- a **hint ladder** from the lightest nudge to almost-the-answer, with each rung logged,
  because reaching for a hint is evidence about difficulty, not cheating;
- **`I don't know — show me`**, which is the only thing that un-hides the recast. The
  elicitation question comes first, always.

Tools also expose their own escapes where they matter: the listening transcript is
behind a learner-controlled reveal, register drills offer "show me all four registers",
grammar beats offer a nudge, and open production offers its hint list without penalty.

---

## 4. Onboarding: twelve stages, and why each exists

Self-report is unreliable; production is expensive. Kotoba mixes both and stores
*confidence* alongside every estimate.

1. **Goal** — job, JLPT/CEFR target, deadline, session length, minutes/day.
2. **Background** — prior study, time in Japan, scripts, prior test scores.
3. **Script** — kana recognition *timed*: accuracy alone misses the reader who
   decodes at 2 s/character. Speed is the predictor of real reading.
4. **Vocabulary** — adaptive staircase over a frequency-banded bank → size estimate,
corrected for guessing (see below).
5. **Grammar** — adaptive staircase over forms, particles, aspect, conditionals.
6. **Reading** — timed passage + comprehension + self-report of which lines were foggy.
7. **Listening** — same content at natural and slowed speed; the *gap* is diagnostic.
8. **Speaking** — three probes: repeat (pronunciation), picture descriptions at rising
   difficulty (fluency/range), two follow-ups (interaction).
9. **Writing** — one functional message, one opinion; kana/kanji/register inspected.
10. **Interview** — a real 5-minute conversation with the voice tutor, whose difficulty
    adapts live. This is the stage that no quiz replaces.
11. **Style** — interests (drives content), correction preference, kanji appetite,
    audio vs text, four-buttons-of-consent for what gets recorded.
12. **Reveal** — the hypothesis: per-skill CEFR with confidence, JLPT estimate, what
    convinced the tutor, what it is *not* sure about, and a 4-week arc. Editable.

Every stage is skippable. A skip is recorded as an absence of evidence, never as a
zero — and the reveal says so out loud: *"Reading is my weakest guess; you skipped the
timed passage."*

Zero-beginner path: stages 1, 2, 3, 4, 8, 11, 12 — measure the writing system, start
speaking on day one, build the rest from real sessions.

---

## 5. Architecture

```
Browser (static SPA, no build step)
   │  fetch /api/*        │  WebSocket
   ▼                      ▼
Cloudflare Worker (Hono) ── glue, auth-free identity, routing
   │            │
   │            └── LiveSessionDO ── relay ⇄ Gemini 3.8 Live (WSS)
   │                  hibernating WebSocket, transcript capture,
   │                  mid-conversation tool calls
   ▼
LearnerDO (per learner, SQLite)
   profile · model · SRS cards · error log · sessions · events
   20h alarm → error ageing, tomorrow's preview
```

- **`wrangler dev` / `npm run deploy`** — one Worker. Static assets are served by the
  same Worker so `/api/*` and the SPA share an origin. No CORS, no second deploy.
- **`LearnerDO`** — one SQLite Durable Object per learner, addressed by a signed
  HttpOnly cookie with an explicit client-held id as fallback (sandboxed iframes and
  third-party-cookie-blocking browsers would otherwise mint a fresh learner on every
  request). Per-user DO isolation is Cloudflare's endorsed pattern for exactly this.
- **`LiveSessionDO`** — a hibernating WebSocket relay. The browser never sees the API
  key, the transcript is captured server-side, and the tutor can call tools
  mid-conversation (`log_error`, `add_to_review`, `lookup_item`, `finish_beat`).
- **Voice** — raw 16 kHz PCM up, 24 kHz PCM down, barge-in enabled, and *deliberately
  generous* end-of-turn silence so the model waits while a learner thinks. Google's
  own Japanese learners are not the population being served here.
- **AI Gateway** — optional but first-class: set `CF_AI_GATEWAY_ACCOUNT`,
  `CF_AI_GATEWAY_ID` and `CF_AIG_TOKEN` and every model call is routed through it for logging, caching
  and rate limiting, with keys held in Secrets Store.
- **Model tiering** — `gemini-3.1-pro-preview` plans (once per session, thinking is
  worth it), `gemini-3.8-flash` runs turns and marking, `gemini-3.5-flash-lite` does
  bulk generation, `gemini-3.8-live` speaks. See *Costs*.
- **`AI_MODE=auto|gemini|mock`** — without a key the app runs a genuine scripted tutor
  rather than breaking. It is labelled as such in the UI.

---

## 6. Gemini 3.8: what it buys us, and what it does not

Researched before a line was written, because the model choice constrains the product.

- **`gemini-3.8-flash`** is the workhorse: ~1.05M-token context (a whole learner
  history fits comfortably), strong multilingual output, $0.75/$3.75 per million tokens
  on introductory pricing through 2026-12-31 — doubling after that, which the cost model
  in §10 already anticipates.
- **`gemini-3.8-live`** (and `-extended-thinking`) does native speech-to-speech: raw
  16 kHz PCM in, 24 kHz out, barge-in, input and output transcription, and tool calling
  *during* the conversation. That last part is the reason a voice session here can log
  an error and schedule a card without leaving the call.
- **The Interactions API is now the recommended interface**, not `generateContent`,
  which is legacy as of June 2026. Two consequences the architecture leans on: the
  server can hold conversation state via `previous_interaction_id` (cheap multi-turn,
  and the learner's history stays server-side), and sensitive onboarding answers can be
  sent with storage disabled.
- **What it does not give us:** there is no Gemini 3.8 Pro. Flagship reasoning is
  `gemini-3.1-pro-preview`, so planning uses that and everything else uses flash — a
  deliberate split rather than assuming one model does all jobs.
- **Text-to-speech is a trap for Japanese.** Cloudflare's Workers AI TTS models are
  English and Spanish only, so they are unusable here; audio comes from Gemini TTS
  (`gemini-3.1-flash-tts-preview`) for quality, with the browser's own `ja-JP` voice as
  the zero-cost, zero-latency fallback for reading aids. Shadowing and pronunciation
  beats deliberately use the good voice, because you cannot learn prosody from a bad one.

## 7. Data model (SQLite, per learner)

`profile` · `model` (skills, metrics, streaks) · `cards` (SRS) · `errors` ·
`sessions` · `events` · `cando` · `notes` · `live` · `kv`.

Three deliberate choices:

- **Errors are first-class rows**, tagged from a 28-tag Japanese-specific taxonomy
  (`particle.wa_ga`, `verb.te_form`, `keigo.humble`, `pron.pitch`, `pron.mora`,
  `vocab.false_friend`, `interaction.aizuchi`, …), each with a coach hint. The progress screen
  shows what the tutor keeps targeting, and the planner reads this table first.
- **Skill levels carry percentiles and confidence, not just labels.** "A1+ at the 72nd
  percentile, 50% confidence" is a plan input; "A1+" is not. Promotion requires sustained
  accuracy at or above a threshold, and a promotion resets the percentile rather than
  jumping a whole level — the same reason real exams are not the only evidence.
- **Guessing is subtracted, and "I don't know" is not a wrong answer.** The vocabulary
  and grammar staircases compute a chance-corrected accuracy floor, so a run of lucky
  four-option guesses cannot set a frontier. An explicit "I don't know" is recorded as an
  absence of evidence rather than a failure: it drops the staircase one level, and it is
  excluded from accuracy entirely, because scoring honesty as error is how a placement
  test talks a careful learner into a level below their real one. The same logic applies
  to a timed kana grid: speed only earns credit on kana you actually read correctly, and
  implausibly fast timings (under 120ms) are discarded rather than rewarded.
- **Every session writes a note**, so "our eighth conversation" can start with the
  right callback instead of an introduction.

---

## 8. Feedback model

A `Feedback` object holds at most three notices, each with:

- the learner's actual words (`quote`) — quoted, not paraphrased;
- the tag and the *issue* in plain English;
- a `recast` (how a native would say it) **hidden behind a tap**;
- an `elicit` question used first: the learner is asked to notice before they are told.

Plus wins that quote real output, target items to keep, and one `nextTime` line. The
learner's correction-timing preference (interrupt vs debrief) is honoured, which the
evidence says matters for satisfaction even where outcomes are equivalent.

A learner can also *argue*: "too easy" and "I already know this" are recorded as
evidence against the model rather than discarded.

---

## 9. Roadmap

**Now (built).** Onboarding instrument, model + evidence store, planner with recipe
selection and adaptation, 16 tools, session runner, debrief, SRS, review, progress,
scripted tutor, voice client, AI Gateway routing, optional task queue.

Also now built, and worth calling out because it changed the product rather than just
verifying it: **browser-based visual QA** (`npm run shots`, `npm run audit`). Driving the
real app in a real browser and *measuring* contrast, tap targets and overflow is what
found that dark-theme buttons were inheriting the browser's default black text, that the
header had no responsive rules at all below 760px, that a stray `??` was appending "this
stage has no UI yet" under every onboarding stage, that the warm-up beat could render
empty when nothing was due, and that the kana score was handing out automaticity credit
for fast guessing. Several of those were invisible in tests and obvious in a screenshot.

**Next (weeks).** Real-content libraries — NHK Easy, Aozora Bunko, tadoku graded
readers — with a rights check before anything ships; pitch-accent reference from OJAD
or NHK; TTS cache in R2 so repeated passages cost nothing; recording archive so you can
hear yourself a month ago; placement-bank expansion to B2/C1 (the seed bank runs thin
above B1, and the staircase caps where content runs out).

**Then.** Learner-facing "why this exercise" transparency panel; peer-style
asynchronous challenge tasks; JLPT/JFT mock mode with sectional timing; offline PWA
with queued events; per-learner export/import of the model as JSON — your data should
be portable, and a tutor that holds your notes hostage is not a good tutor.

**Explicitly rejected.** Unending sentence-drilling with a score (the monologic
pattern the research is unkind to); streaks with loss-aversion pressure; native-speed
audio with no slow path; and romaji rendered by default, which teaches the eye to skip
the kana.

---

## 10. Costs

At Gemini 3.8 pricing (flash $0.75/$3.75 per M tokens through 2026-12-31; double that
afterwards), a 20-minute text session lands around 2–5¢. A 20-minute *voice* session is
the expensive one: Live audio is billed by duration, so budget roughly 20–40¢ with a
cached-TTS reading path and a text-first default. A learner doing five sessions a week
therefore costs about $1–8/month depending on how much of it is voice.

That is the honest reason the app defaults to text with optional voice rather than
being a voice-first product: 1-on-1 tutor feel at 1-on-1-tutor frequency prices a
product out of existence. Levers held in reserve: AI Gateway caching of repeated
generations, flash-lite for bulk content, pre-generated previews, and a per-learner
daily token budget stored in the DO.

---

## 11. Honest status

**Verified working** (run under `wrangler dev` in this sandbox): health, identity
cookie + fallback, the full placement cycle including the adaptive staircase, session
start → event → turn → mark → finish, review scheduling and grading, progress,
tomorrow-preview, gloss/story/register tools, tutor Q&A, and every SPA asset.

**Wired but never executed against the live API**: the Gemini Interactions calls, the
Live WebSocket relay, TTS, and ephemeral-token direct mode. They are written against
the documented shapes, with tolerant parsing because the response envelopes have moved
across versions, but *no key existed in this sandbox to prove them.* Treat the first
keyed run as a test, not a launch.

**Known gaps**: `liveSessionConfig` and `validateBeat` are imported but unused in the
worker entry; `LiveSessionDO` carries a local `setupFrame()` that should be collapsed
into `gemini.ts`; the HTTP-level Durable Object reset alarm (auto-resolving stale
errors after 21–30 days) has not been observed firing, only its logic exercised.

**One thing the browser found that the tests could not.** A learner who answered one
question in twelve correctly, quickly, was being credited with *automaticity* — the kana
score averaged the speed of wrong answers into the same number as right ones. It took a
screenshot of a nonsensical line ("Kana accuracy 8%, median response 431ms") to see it.
Any measurement that rewards speed independent of correctness is measuring something
other than what it claims to.

**The one thing I would change about the brief.** "Comprehensive onboarding" and "a
tutor who starts teaching in ninety seconds" are in tension, and the honest resolution
is that onboarding has to *feel* like tutoring, not like an exam. Every stage here is
skippable, the profile is presented as a hypothesis with error bars, and the first real
session starts before the profile is finished — stage 12 offers to run today's session
immediately, using whatever evidence exists. If a learner bails at stage 4, they still
get a tutor, just a more curious one.
