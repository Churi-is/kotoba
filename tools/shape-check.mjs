#!/usr/bin/env node
/**
 * shape-check.mjs — offline assertions for the Gemini client's wire shapes.
 *
 *   npm run check:shapes      (node --experimental-strip-types tools/shape-check.mjs)
 *
 * No key, no network: this is the part of the contract that can be verified from the
 * docs alone (request field names and placement, schema sanitising, response parsing,
 * thinking-level tables, Live setup layout, socket URLs). `tools/gemini-smoke.mjs`
 * covers the same ground against the live API when a key exists.
 *
 * The assertions that matter most are the ones that used to be wrong: the request
 * carried `response_schema` / `response_mime_type` / `temperature` (all removed from
 * the API), dropped `system_instruction`, and sent the Live socket to the wrong host.
 */

const gemini = await import(new URL('../src/ai/gemini.ts', import.meta.url).href);
const {
  MODEL_FOR, baseUrl, extractAudio, extractText, interactionBody, liveSetup,
  liveSocket, liveThinkingLevel, parseJsonLoose, sanitizeSchema, thinkingLevelFor,
} = gemini;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const json = (v) => JSON.stringify(v);
const env = (over = {}) => ({ GEMINI_API_KEY: 'test-key', ...over });

// ---------------------------------------------------------------- request body

const schemaCall = {
  model: 'gemini-3.8-flash',
  input: 'Return JSON.',
  system: 'You are a tutor.',
  schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
  previousInteractionId: 'int_123',
  thinking: 'balanced',
};
const body = interactionBody(schemaCall);

check('body.model passes through', body.model === 'gemini-3.8-flash');
check('body.input passes through', body.input === 'Return JSON.');
check('system → system_instruction', body.system_instruction === 'You are a tutor.');
check('no response_schema field', !('response_schema' in body));
check('no response_mime_type field', !('response_mime_type' in body));
check('no temperature anywhere', !json(body).includes('temperature'));
check('no OpenAI-shaped response_format', !json(body).includes('json_schema'));
check(
  'response_format is {type:text, mime_type, schema}',
  body.response_format?.type === 'text'
    && body.response_format?.mime_type === 'application/json'
    && body.response_format?.schema?.properties?.a?.type === 'string',
  json(body.response_format),
);
check('previous_interaction_id carried', body.previous_interaction_id === 'int_123');
check('thinking_level inside generation_config', body.generation_config?.thinking_level === 'low');
check('schema calls get an output ceiling', body.generation_config?.max_output_tokens === 16_384);

const plain = interactionBody({ model: 'gemini-3.8-flash', input: 'hi', maxOutputTokens: 2048, thinking: 'balanced' });
check('plain call: no response_format', plain.response_format === undefined);
check('plain call: ceiling honoured', plain.generation_config.max_output_tokens === 2048);
check('plain call: no system_instruction when unset', plain.system_instruction === undefined);

const tooled = interactionBody({
  model: 'gemini-3.8-flash',
  input: 'x',
  tools: [{ name: 'log_error', description: 'log', parameters: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] } }],
});
check('function tools get type:"function"', tooled.tools?.[0]?.type === 'function', json(tooled.tools?.[0]));
check('builtin tool blocks pass through', interactionBody({
  model: 'gemini-3.8-flash', input: 'x', tools: [{ type: 'google_search' }],
}).tools?.[0]?.type === 'google_search');
check('store:false is explicit when asked', interactionBody({ model: 'm', input: 'x', store: false }).store === false);
check('store is omitted by default (server-side state)', interactionBody({ model: 'm', input: 'x' }).store === undefined);

// ---------------------------------------------------------------- model tables

check('3.8-flash: balanced → low (minimal is a 400 at 3.7+)', thinkingLevelFor('gemini-3.8-flash', 'balanced') === 'low');
check('3.8-flash: deep → high', thinkingLevelFor('gemini-3.8-flash', 'deep') === 'high');
check('3.8-flash: minimal is never sent', thinkingLevelFor('gemini-3.8-flash', 'minimal') !== 'minimal');
check('3.1-pro: deep → high', thinkingLevelFor('gemini-3.1-pro-preview', 'deep') === 'high');
check('3.1-pro: bulk → low (no minimal on Pro)', thinkingLevelFor('gemini-3.1-pro-preview', 'bulk') === 'low');
check('3.5-flash-lite: bulk → minimal', thinkingLevelFor('gemini-3.5-flash-lite', 'bulk') === 'minimal');
check('2.5 family: no thinking_level at all', thinkingLevelFor('gemini-2.5-pro', 'deep') === undefined);
check('unknown model: level omitted rather than guessed', thinkingLevelFor('gemini-future-9', 'deep') === undefined);
check('models/ prefix tolerated', thinkingLevelFor('models/gemini-3.8-flash', 'balanced') === 'low');

check('live 3.8-live: no thinkingConfig', liveThinkingLevel('gemini-3.8-live') === undefined);
check('live extended-thinking: requires a level', liveThinkingLevel('gemini-3.8-live-extended-thinking') === 'low');
check('live extended-thinking: minimal is downgraded', liveThinkingLevel('gemini-3.8-live-extended-thinking', 'minimal') === 'low');
check('live extended-thinking: high survives', liveThinkingLevel('gemini-3.8-live-extended-thinking', 'high') === 'high');

// ---------------------------------------------------------------- schema sanitising

const dirty = sanitizeSchema({
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'x',
  type: 'object',
  properties: {
    words: { type: 'array' },
    note: { type: 'string', pattern: '^a', examples: ['a'] },
    meta: { type: ['string', 'null'], description: 'ok' },
  },
  required: ['words', 'note', 'ghost'],
  additionalProperties: false,
});
check('$schema/$id stripped', !('$schema' in dirty) && !('$id' in dirty));
check('unsupported keywords stripped (pattern, examples)', !json(dirty).includes('pattern') && !json(dirty).includes('examples'));
check('array without items gets items:{}', json(dirty.properties.words) === '{"type":"array","items":{}}');
check('supported keywords survive', dirty.properties.meta.description === 'ok' && dirty.additionalProperties === false);
check('required filtered to declared properties', json(dirty.required) === '["words","note"]', json(dirty.required));
check('nested arrays keep their item schema', json(sanitizeSchema({
  type: 'object', properties: { xs: { type: 'array', items: { type: 'integer' } } },
})).includes('"items":{"type":"integer"}'));
check('$ref schemas fail loudly instead of becoming empty schemas', (() => {
  try { sanitizeSchema({ type: 'object', properties: { a: { $ref: '#/$defs/x' } } }); return false; } catch { return true; }
})());

// ---------------------------------------------------------------- tts

const tts = gemini.ttsBody(env({ MODEL_TTS: 'tts-model' }), 'おはよう', { voice: 'Kore' });
check('tts: response_format is {type: audio}', json(tts.response_format) === '{"type":"audio"}');
check('tts: speech_config is a list of {voice}', json(tts.generation_config.speech_config) === '[{"voice":"Kore"}]');
check('tts: model override honoured', tts.model === 'tts-model');

// ---------------------------------------------------------------- response parsing

const stepsBody = {
  id: 'int_abc',
  status: 'completed',
  usage: { total_input_tokens: 120, total_output_tokens: 40, total_thought_tokens: 900 },
  steps: [
    { type: 'thought', content: [{ type: 'text', text: 'let me think about braces { like this' }] },
    { type: 'model_output', status: 'done', content: [{ type: 'text', text: '{"ok":true}' }] },
  ],
};
const parsed = extractText(stepsBody);
check('steps → text (thought step skipped)', parsed.text === '{"ok":true}', parsed.text);
check('interaction id read from body.id', parsed.interactionId === 'int_abc');
check('usage mapped from totals', parsed.usage.input === 120 && parsed.usage.output === 40 && parsed.usage.thoughts === 900);
check('status surfaces as finishReason', parsed.finishReason === 'completed');
check('JSON parsed out of the step text', parseJsonLoose(parsed.text)?.ok === true);

check('an unknown deliberation step type is not mistaken for the answer', extractText({
  steps: [
    { type: 'reasoning', content: [{ type: 'text', text: '{"trap":true}' }] },
    { type: 'model_output', content: [{ type: 'text', text: '{"real":true}' }] },
  ],
}).text === '{"real":true}');
check('non-text blocks are ignored', extractText({
  steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'X' }, { type: 'text', text: 'ok' }] }],
}).text === 'ok');
check('truncated step still yields its partial text', extractText({
  id: 'int_x', status: 'incomplete', steps: [{ type: 'model_output', status: 'incomplete', content: [{ type: 'text', text: '{"a":' }] }],
}).finishReason === 'incomplete');
check('output_text convenience property honoured', extractText({ output_text: 'hello' }).text === 'hello');
check('legacy outputs array honoured', extractText({ outputs: [{ text: 'legacy' }] }).text === 'legacy');
check('legacy candidates honoured', extractText({ candidates: [{ content: { parts: [{ text: 'old shape' }] } }] }).text === 'old shape');

const audio = extractAudio({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'BASE64', mime_type: 'audio/l16', sample_rate: 24000 }] }] });
check('audio content block extracted', audio?.audioBase64 === 'BASE64', json(audio));
check('audio mime falls back to PCM', Boolean(extractAudio({ steps: [{ content: [{ inline_data: { data: 'X' } }] }] })?.mimeType.includes('audio/')));
check('no audio → undefined', extractAudio({ steps: [{ content: [{ type: 'text', text: 'hi' }] }] }) === undefined);

check('fenced JSON parsed', parseJsonLoose('```json\n{"a":1}\n```')?.a === 1);
check('prose before JSON skipped', parseJsonLoose('Here you go: notes{not json} then {"a":2}')?.a === 2);

// ---------------------------------------------------------------- live + transport

const live = liveSetup({ model: 'gemini-3.8-live', systemInstruction: 'Be Aoi.', tools: [{ name: 'finish_beat', description: 'd', parameters: { type: 'object', properties: { met: { type: 'boolean' } }, required: ['met'] } }] });
check('live: modalities inside generationConfig', live.setup.generationConfig.responseModalities[0] === 'AUDIO');
check('live: voice config nested correctly', live.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName === 'Aoede');
check('live: ja-JP by default', live.setup.generationConfig.speechConfig.languageCode === 'ja-JP');
check('live: no thinkingConfig for 3.8-live', live.setup.generationConfig.thinkingConfig === undefined);
check('live: tools at the top of setup', live.setup.tools?.[0]?.functionDeclarations?.[0]?.name === 'finish_beat');
check('live: tool params sanitised', live.setup.tools[0].functionDeclarations[0].parameters.required[0] === 'met');
check('live: VAD window is learner-sized', live.setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs === 1800);
// The API takes exactly HIGH | LOW here and rejects the whole setup frame (1007) for
// anything else — including the "MEDIUM" that shipped in the original setup. Voice mode
// never worked because of it, so it is worth an assertion rather than a comment.
{
  const aad = live.setup.realtimeInputConfig.automaticActivityDetection;
  const valid = new Set(['HIGH', 'LOW']);
  const ends = (v) => valid.has(String(v).replace(/^(START|END)_SENSITIVITY_/, ''));
  check('live: speech sensitivities are real enum values', ends(aad.startOfSpeechSensitivity) && ends(aad.endOfSpeechSensitivity),
    `start=${aad.startOfSpeechSensitivity} end=${aad.endOfSpeechSensitivity}`);
}
check('live: barge-in on', live.setup.realtimeInputConfig.activityHandling === 'START_OF_ACTIVITY_INTERRUPTS');
check('live: transcriptions requested', 'inputAudioTranscription' in live.setup && 'outputAudioTranscription' in live.setup);
check('live: resumption + compression set', 'sessionResumption' in live.setup && 'contextWindowCompression' in live.setup);
check('live: systemInstruction uses parts', live.setup.systemInstruction.parts[0].text === 'Be Aoi.');

check('live: plain models get blocking declarations (no behavior field)', live.setup.tools[0].functionDeclarations[0].behavior === undefined);

const deepLive = liveSetup({
  model: 'gemini-3.8-live-extended-thinking',
  systemInstruction: 'x',
  thinking: 'high',
  tools: [{ name: 'finish_beat', description: 'd', parameters: { type: 'object', properties: { met: { type: 'boolean' } } } }],
});
check('live extended-thinking: thinkingConfig present', deepLive.setup.generationConfig.thinkingConfig?.thinkingLevel === 'high');
check('live extended-thinking: declarations are NON_BLOCKING', deepLive.setup.tools[0].functionDeclarations[0].behavior === 'NON_BLOCKING');
check('live deep setup keeps resumption empty-allowed', 'sessionResumption' in deepLive.setup);

check('direct socket uses BidiGenerateContent + key', liveSocket(env(), { model: 'gemini-3.8-live' }).url
  .startsWith('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key='));
check('ephemeral token uses the Constrained socket', liveSocket(env(), { model: 'gemini-3.8-live', token: 'auth_tokens/abc' }).url
  .includes('BidiGenerateContentConstrained?access_token=auth_tokens%2Fabc'));
check('ephemeral token socket sends no key', !liveSocket(env(), { model: 'gemini-3.8-live', token: 't' }).url.includes('key='));

const gw = env({ CF_AI_GATEWAY_ACCOUNT: 'acct', CF_AI_GATEWAY_ID: 'gw', CF_AIG_TOKEN: 'tok' });
check('gateway REST base includes /v1beta', baseUrl(gw).url === 'https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta');
check('gateway REST base is tagged as gateway transport', baseUrl(gw).transport === 'gateway');
check('direct base defaults to the Google v1beta root', baseUrl(env()).url === 'https://generativelanguage.googleapis.com/v1beta');
const gwLive = liveSocket(gw, { model: 'gemini-3.8-live' });
check('gateway live socket uses the /google provider segment', gwLive.url.startsWith('wss://gateway.ai.cloudflare.com/v1/acct/gw/google?api_key='), gwLive.url);
check('gateway live socket sends the gateway token as a header', gwLive.headers['cf-aig-authorization'] === 'Bearer tok');
check('gateway-configured ephemeral token still goes direct', liveSocket(gw, { model: 'm', token: 't' }).url.startsWith('wss://generativelanguage.googleapis.com/'));

check('model ids resolve for every role', ['planner', 'tutor', 'fast', 'live', 'liveDeep', 'tts']
  .every((role) => typeof MODEL_FOR(env(), role) === 'string' && MODEL_FOR(env(), role).length > 0));
check('env overrides win over defaults', MODEL_FOR(env({ MODEL_TUTOR: 'custom-model' }), 'tutor') === 'custom-model');

// A chained call must not carry store:false — the API answers
// "store must be true when previous_interaction_id is set" (verified live, 400).
const chained = interactionBody({ model: 'm', input: 'x', previousInteractionId: 'int_x', store: false });
check('chaining never sends store:false', chained.previous_interaction_id === 'int_x' && !('store' in chained));
check('store:false still honoured when not chaining', interactionBody({ model: 'm', input: 'x', store: false }).store === false);

// ---------------------------------------------------------------- summary

console.log(`${passed} shape assertions passed${failures.length ? `, ${failures.length} failed` : ''}`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
