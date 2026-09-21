# The Gemini API as it actually is (checked 2026-09-21)

This is the reference behind `src/ai/gemini.ts`. Every shape below was read off the
current docs, not remembered: the API replaced its request format in May 2026 and the
old field names are now **hard 400s**, not deprecation warnings. `tools/gemini-smoke.mjs`
exercises each one against the live API when you have a key.

Sources at the bottom. The short version first.

---

## 1. Interactions API — `POST /v1beta/interactions`

The recommended interface now; `generateContent` is legacy. Request fields that matter:

| Field | Shape | Notes |
| --- | --- | --- |
| `model` | `"gemini-3.8-flash"` | or `agent` instead of `model` |
| `input` | string, Content, or array of Step | a plain string is fine |
| `system_instruction` | **string, top level** | *not* inside the input |
| `response_format` | `{type:'text', mime_type:'application/json', schema:{…}}` | structured output |
| `generation_config` | `{max_output_tokens, thinking_level, thinking_summaries, speech_config, tool_choice}` | model behaviour only |
| `tools` | `[{type:'function', name, description, parameters}]` | or `{type:'google_search'}` etc. |
| `previous_interaction_id` | `"int_…"` | server-side conversation state |
| `store` | bool, default `true` | `store:false` disables `previous_interaction_id` |
| `background` | bool | long-running work |

Response: an `Interaction` — `id`, `status`, `usage`, and `steps[]`
(`model_output`, `thought`, `function_call`, `function_result`, `user_input`). Content
is typed blocks: `{type:'text', text}`, `{type:'audio', data, mime_type, sample_rate}`,
`{type:'image'|'document', data, mime_type}`. `output_text` / `output_audio` are
convenience accessors over the last model block. `POST` returns only model-generated
steps; `GET /interactions/{id}` adds the inputs back.

### What broke in this repo

```ts
// before — every one of these is a 400 against the current API
generationConfig.response_mime_type = 'application/json';
generationConfig.response_schema = call.schema;                  // → "Unknown parameter 'response_schema'"
generationConfig.temperature = 0.9;                              // no longer a field at all
body.response_format = { type: 'json_schema', json_schema: {…} }; // OpenAI-shaped, wrong vocabulary
body.response_schema = call.schema;                              // duplicated at the top level too
// …and `system` was accepted by the signature and never sent.
```

* `temperature`, `top_p`, `top_k` are **gone** for Gemini 3.x: ignored today, and
Google has said future generations reject them outright. The replacement dial is
`generation_config.thinking_level`, and level support is per model — `minimal` became a
400 on 3.7+ Flash, Pro only takes `low`/`high`. `thinkingLevelFor()` in gemini.ts keeps a
table and sends *nothing* for a model it does not recognise, because the default is
always a valid request.

* `previous_interaction_id` carries the **conversation contents** only:
  `system_instruction`, `tools` and `generation_config` are interaction-scoped and must
  be re-sent on every turn (we do), and `store: false` disables chaining outright.
  Stored interactions last 55 days on paid tiers, 1 day on free — so the id is treated
  as an optimisation, never as the only copy of the lesson: when a call with an id
  fails, `converse()` retries once with the full history and no id.
* `max_output_tokens` is a **combined** budget for thoughts + answer. A reasoning model
  can spend the whole thing thinking and hand back a truncated object, which is why a
  structured retry lowers the thinking level and raises the ceiling rather than just
  re-rolling the dice.
* *Latency budget.* The client aborts slow calls before Cloudflare's 100s edge/gateway
  timeout turns them into a bare `524`: 60s by default, 90s for the planner and
  placement synthesis. Those two used to run high thinking with a 32k ceiling and
  timed out in production (`gemini 524` after minutes of spinner); they now run low
  thinking with 16k, still far above the ~4–8k tokens a full plan needs. A timeout
  throws a retryable error — never retried silently, because a second 90s generation
  the learner didn't ask for is worse than a clear message with a retry button.
* Structured output supports a subset of JSON Schema: `type` (`string`/`number`/
  `integer`/`boolean`/`object`/`array`/`null`, and `["string","null"]` unions),
  `properties`, `required`, `additionalProperties`, `enum`, `format`, `items`,
  `prefixItems`, `minItems`, `maxItems`, `minimum`, `maximum`, `title`, `description`.
  `sanitizeSchema()` rebuilds to that list, adds a missing `items: {}` (an `array`
  without `items` is a 400 on the whole request) and drops `required` entries that name
  undeclared properties.
* Streaming: SSE events `interaction.created`, `step.delta`, …; we don't stream.

## 2. Live API — WebSocket, `BidiGenerateContent`

```
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=API_KEY
wss://…BidiGenerateContentConstrained?access_token=EPHEMERAL_TOKEN   ← short-lived tokens
```

Field placement in `setup` is load-bearing:

```jsonc
{ "setup": {
    "model": "models/gemini-3.8-live",
    "generationConfig": {                       // modalities, voice, thinking live here
      "responseModalities": ["AUDIO"],
      "speechConfig": { "languageCode": "ja-JP",
                        "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Aoede" } } },
      "thinkingConfig": { "thinkingLevel": "low" }   // ONLY for -extended-thinking
    },
    "systemInstruction": { "parts": [{ "text": "…" }] },
    "tools": [{ "functionDeclarations": [ … ] }],     // top level
    "realtimeInputConfig": { "automaticActivityDetection": { … }, "activityHandling": "…" },
    "inputAudioTranscription": {}, "outputAudioTranscription": {},
    "sessionResumption": {}, "contextWindowCompression": { "slidingWindow": {} }
} }
```

The trap we were one field away from: **thinking is model-dependent, in opposite
directions.** `gemini-3.8-live-extended-thinking` closes the socket with `1007 Thinking
level must be specified` if `generationConfig.thinkingConfig.thinkingLevel` is absent,
and `minimal` is rejected; every other Live model (including `gemini-3.8-live`) closes
with `1007 Thinking level is not supported for this model` if it *is* present.
`liveThinkingLevel()` decides from the model id — the caller never guesses.

Audio is raw 16-bit PCM: 16 kHz up (`realtimeInput.audio`, `audio/pcm;rate=16000`),
24 kHz down. Text is `realtimeInput.text`; a finished turn is `serverContent.turnComplete`;
barge-in is `serverContent.interrupted`. `setupComplete` must arrive before anything else.

Every client message carries **exactly one** of `setup`, `clientContent`, `realtimeInput`,
`toolResponse`. `activityStart`/`activityEnd` are legal *only* when automatic activity
detection is disabled; with server VAD on (our setting) the "mic went away" signal is
`realtimeInput.audioStreamEnd: true`. Tool results go back as
`{toolResponse: {functionResponses: [{id, name, response}]}}` — the id is how the server
matches them, and a response without one is rejected.

**Extended thinking changes two more things** (this is the part that only shows up in
the thinking guide, not the reference): every function declaration must carry
`"behavior": "NON_BLOCKING"` — the model runs tools in the background while it keeps
talking, and a blocking declaration is an error — and the session idle signal becomes
`interactionStatus` (`IN_PROGRESS` while reasoning/speaking, `IDLE` when actually
waiting for the learner), sent alongside `turnComplete`. Our relay forwards it and the
voice panel shows "thinking…".

**Ephemeral tokens** (`POST /v1beta/auth_tokens`): `{uses, expireTime,
newSessionExpireTime}` — camelCase — and the token comes back under `name`, not
`token`/`access_token`. Renew roughly every 10 minutes with `sessionResumption` (a
resume does not consume a use). Tokens work only against `v1beta` and only for Live;
`liveConnectConstraints: {model, config}` locks a token to one setup, and
`bidiGenerateContentSetup` + `field_mask` pins individual fields instead — we send
neither, so the holder's own setup message is honoured.

**Via Cloudflare AI Gateway** the realtime route uses a different provider segment than
REST: `wss://gateway.ai.cloudflare.com/v1/{account}/{gateway}/google?api_key=…`
(REST is `…/google-ai-studio/v1beta/interactions`). The gateway token goes in a header
on a Workers upgrade request; browsers use the `cf-aig-authorization.<token>` subprotocol.

## 3. TTS — `gemini-3.1-flash-tts-preview`

Speech generation is a media request now, not a modality flag:

```jsonc
{ "model": "gemini-3.1-flash-tts-preview",
  "input": "Say cheerfully: おはよう",
  "response_format": { "type": "audio" },
  "generation_config": { "speech_config": [ { "voice": "Kore" } ] } }   // a list; {speaker, voice} for two
```

The audio arrives as an `audio` content block (base64 PCM, 24 kHz); `output_audio.data`
is the SDK convenience over the last one. `response_modalities` no longer exists, and
`speech_config` is a **list** of `{voice}` objects, not the old
`{language_code, voice_config: {prebuilt_voice_config: {voice_name}}}`.

## 4. Models in play

`wrangler.jsonc` routes to `gemini-3.1-pro-preview` (planner), `gemini-3.8-flash`
(tutor), `gemini-3.5-flash-lite` (bulk), `gemini-3.8-live` / `-extended-thinking`
(voice), `gemini-3.1-flash-tts-preview` (audio). All five ids are current. The 3.8 Live
pair is Live-API-only (`generateContent` answers 400), which matches how we use them.

## 5. Verifying

```bash
npm run check:shapes                                  # offline: the wire shapes, no key
GEMINI_API_KEY=… npm run smoke                        # every call shape, live
GEMINI_API_KEY=… npm run smoke -- --live-only         # just the voice sockets
```

`check:shapes` needs no key and no network — it asserts the request bodies (`response_format`
at the top, no `response_schema`, no `temperature`, `system_instruction` present), the
per-model thinking tables, schema sanitising, response parsing, and the Live setup frame.
`smoke` runs the same shapes against the API and fires three deliberately-wrong requests
(top-level `response_schema`; `thinkingConfig` on plain `gemini-3.8-live`; a BLOCKING
declaration on the thinking model) so you can see the failures the checks are guarding
against rather than taking this file's word for it.

## Sources

- Interactions API reference — <https://ai.google.dev/api/interactions-api-v1>
- Interactions overview (state, retention, model table) — <https://ai.google.dev/gemini-api/docs/interactions-overview>
- Structured output — <https://ai.google.dev/gemini-api/docs/structured-output>
- May 2026 breaking changes (removal of `response_mime_type`/`response_modalities`) — <https://ai.google.dev/gemini-api/docs/interactions-breaking-changes-may-2026>
- Thinking levels and `max_output_tokens` — <https://ai.google.dev/gemini-api/docs/thinking>
- Live API WebSocket reference — <https://ai.google.dev/api/live>
- Thinking in the Live API (`NON_BLOCKING` tools, `interactionStatus`) — <https://ai.google.dev/gemini-api/docs/live-api/thinking>
- Live API WebSocket getting started — <https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket>
- Ephemeral tokens — <https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens>
- TTS — <https://ai.google.dev/gemini-api/docs/speech-generation>
- Models — <https://ai.google.dev/gemini-api/docs/models>
- Cloudflare AI Gateway, Google AI Studio — <https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/>
- Cloudflare AI Gateway, Realtime WebSockets — <https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/>
