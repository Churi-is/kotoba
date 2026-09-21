# Kotoba 言葉

A 1:1 AI Japanese tutor. **Gemini 3.8 designs the sessions; the app provides the tools.**

One Cloudflare Worker: static SPA, HTTP API, one SQLite Durable Object per learner, and
a hibernating WebSocket relay to Gemini 3.8 Live for spoken sessions. No build step, no
framework, no external services beyond the model.

The design rationale, the research it is based on, the data model and the honest list of
what is and is not verified live in **[PLAN.md](./PLAN.md)**. This file is just how to run it.

---

## Run it

```bash
./tools/bootstrap.sh   # Node 22 + deps + a chromium for the visual QA
npm run dev            # http://localhost:8787
```

Wrangler 4.x refuses Node 20, so the bootstrap script brings its own. It installs the
toolchain — Node plus a Playwright chromium, about 230 MB — to `/opt/kotoba-tools`
(override with `TOOLS_DIR=...`), deliberately **outside** the project: that much binary
does not belong in a repo, a backup, or a workspace quota. Nothing outside this
directory is needed to read the code, only to run it.

Open `http://localhost:8787`. That is the whole app.

If you would rather use a Node 22 you already have, skip the script and just:
`npm ci && npm run dev`.

**A model key is required.** There is no scripted/demo tutor: with no key configured
the API answers `503 ai_not_configured` with the exact setup command, the app shows a
red banner instead of a lesson, and nothing generates template content pretending to
be a tutor. Placement, sessions, marking and review generation all run on the model —
the only thing that works keyless is static browsing of the UI.

## Turn on the tutor

```bash
npx wrangler secret put GEMINI_API_KEY      # Google AI Studio key
npm run dev
```

Optional, and recommended — route every call through AI Gateway for logging, caching
and rate limits, with the Google key held in Secrets Store (BYOK) rather than in the
Worker:

```bash
npx wrangler secret put CF_AI_GATEWAY_ACCOUNT   # your account id
npx wrangler secret put CF_AI_GATEWAY_ID        # gateway name
npx wrangler secret put CF_AIG_TOKEN            # gateway auth token
```

Model routing lives in `wrangler.jsonc` and is worth keeping as-is: planning and
placement synthesis use the reasoning model, in-session turns use `gemini-3.8-flash`,
bulk generation uses `flash-lite`, voice uses `gemini-3.8-live`, and Japanese audio
uses Gemini TTS.

## Verify the model wiring

The API is strict: an unknown field is a `400`, and the request shape changed in
May 2026 (`response_schema` and `response_mime_type` no longer exist; structured
output is one `response_format` object). Two checks keep us honest —
**[docs/gemini-api.md](./docs/gemini-api.md)** is the reference both are written against:

```bash
npm run check:shapes                     # offline: request bodies, parsing, Live setup
GEMINI_API_KEY=… npm run smoke           # live: every call shape, plus one deliberate 400
```

`check:shapes` needs no key and no network, and it asserts the exact things that broke
before: no `response_schema`, no `temperature`, `system_instruction` present, thinking
levels resolved per model, the Live socket on the right host. `smoke` runs the same
shapes against the real API and also opens a voice socket — if something in Google's
surface moves again, that is the tool that will say so first.

## Configuration

`AI_MODE` (`auto` | `gemini`) is accepted for compatibility; both require a key.
`AI_MODE=mock` now throws on startup paths — the scripted tutor was removed, so a
stale config is caught loudly instead of silently teaching templates.

No silent fallback: if a model call fails (bad key, quota, outage) the API returns
`502 ai_call_failed` or `502 ai_output_invalid` with the underlying message, and the
UI shows it. You find out the tutor is broken immediately, not after a week of
lessons that were quietly templates.

## Deploy

```bash
npm run deploy        # wrangler deploy
```

The queue `kotoba-tasks` is optional; create it (`npx wrangler queues create
kotoba-tasks`) before deploying if you want background generation of the next session
pack, or delete the `queues` block from `wrangler.jsonc`.

## Look at it, do not guess at it

Two Playwright harnesses live in `tools/`. Both drive the *real* app in a real browser —
no fixtures, no mocks — so they catch the class of bug that unit tests never will.

```bash
npx playwright install chromium     # once
npm run seed                        # build a realistic learner through the public API
npm run shots                       # → shots/*.png, every screen, desktop + mobile
npm run audit                       # → measured report, exits 1 on any failure
npm run audit:mobile
```

`npm run audit` walks the whole app — onboarding start to finish, three sessions, the
debrief, progress, memory, the status dialog, both viewports — and *measures*:

- **Text contrast** against WCAG AA, resolving effective colours through nested
  semi-transparent layers and sampling gradient stops (my first version of this had the
  alpha compositing wrong and invented a failure, which is exactly why it reports numbers
  rather than adjectives);
- **Controls** whose text is invisible against their own background (computed colour
  equal to computed background);
- **Tap targets** under 24px;
- **Horizontal overflow** past the viewport.

It also fails loudly if it audited suspiciously few screens, because "0 problems" and
"0 work performed" look identical in a naive report — a tool you cannot trust is worse
than no tool. Findings are screenshotted to `shots/audit/` so you can look at the thing
that was measured.

`npm run shots` additionally records every console error, uncaught exception and failed
request, and exits non-zero if any appear.

Browsers resolve from `PLAYWRIGHT_BROWSERS_PATH`, `/opt/kotoba-tools/pw-browsers`, or the
default Playwright cache, in that order (see `tools/shotlib.mjs`). Screenshots are written
to `shots/`, which is git-ignored — they are artefacts to look at, not source to keep.

## Cheat sheet

```bash
npm run check    # tsc --noEmit, strict
npm run types    # regenerate binding types from wrangler.jsonc
npm run tail     # live logs from the deployed Worker
```

Useful endpoints: `GET /api/health` (mode, transport, whether a key is visible, and
which model each role uses), `GET /api/learner` (full profile + model + due cards +
session preview), `POST /api/placement/{start,item,answer,stage,finish}`,
`POST /api/session/{start,:id/event,:id/turn,:id/beat/:beatId/mark,:id/finish}`,
`GET /api/progress`, `GET /api/review/due`, `POST /api/tools/{gloss,story,register,tts}`,
`POST /api/tutor/ask`.

## Layout

```
tools/
  bootstrap.sh          get from clone → running in one command
  shots.mjs             drive the real app in a browser, write screenshots
  audit.mjs             measure contrast / tap targets / overflow
  seed.mjs              build a realistic learner through the public API
src/
  index.ts              Hono entrypoint: identity, all /api/* routes, SPA fallback
  types.ts              domain spine (levels, skills, beats, plans, feedback)
  domain/pedagogy.ts    CEFR/JLPT maths, 28-tag error taxonomy, SRS, recipes
  domain/tasks.ts       the sixteen tools: contracts, events, marking strategy
  domain/placement.ts   12-stage onboarding instrument, adaptive staircase
  content/seed.ts       curriculum: vocabulary, grammar, kanji, scenarios, probes
  ai/prompts.ts         persona, planner/turn/feedback prompts, JSON schemas
  ai/gemini.ts          Interactions API client, Live setup, tools, TTS, gateway
  ai/brain.ts           TutorBrain interface, Gemini implementation, config errors
  domain/templates.ts   validated drill templates for mid-session injects
  domain/learner-model.ts  numeric seed for the learner model from placement evidence
  runtime/learner.ts    LearnerDO: SQLite learner model + all mutations
  runtime/live.ts       LiveSessionDO: voice relay, transcript capture
public/
  index.html app.css    the SPA shell and visual system
  app.js                controller: onboarding, session, progress, memory
  session.js            session runner + a renderer for each of the 16 tools
  live.js               voice client (24 kHz playback queue, barge-in, 16 kHz mic)
  audio.js api.js       TTS/recording, DOM + fetch helpers
```

## Before you trust it

The HTTP surface, the placement instrument, scheduling and every SPA asset are verified
running. **The Gemini calls themselves — Interactions, Live relay, TTS — have never been
executed against the live API**, because no key existed in the environment where this
was built. They are written to the documented shapes with tolerant parsing, but treat the
first keyed run as a test rather than a launch. `GET /api/health` tells you exactly which
transport is armed before you start.
