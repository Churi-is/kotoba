#!/usr/bin/env node
/**
 * gemini-smoke.mjs — proves the shapes in src/ai/gemini.ts against the live API.
 *
 *   GEMINI_API_KEY=… node tools/gemini-smoke.mjs
 *   GEMINI_API_KEY=… node tools/gemini-smoke.mjs --live-only
 *   GEMINI_API_KEY=… node tools/gemini-smoke.mjs --base https://…/v1beta
 *
 * No dependencies, no build step, runs on Node 22 (global fetch + WebSocket).
 * Each check prints PASS/FAIL and the reason; the process exits non-zero if any
 * required check failed. The last check is a deliberate negative control: it sends
 * the field that caused our 400s so you can see the API's own error message.
 *
 * Assumes the same env vars as the Worker (MODEL_TUTOR, MODEL_LIVE, … ) so a
 * deployed configuration can be mirrored here verbatim.
 */

const KEY = process.env.GEMINI_API_KEY;
const BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const ARGS = process.argv.slice(2);
const flag = (name) => ARGS.includes(name);
const valueOf = (name) => {
  const i = ARGS.indexOf(name);
  return i >= 0 ? ARGS[i + 1] : undefined;
};

const MODELS = {
  tutor: process.env.MODEL_TUTOR || 'gemini-3.8-flash',
  planner: process.env.MODEL_PLANNER || 'gemini-3.1-pro-preview',
  fast: process.env.MODEL_FAST || 'gemini-3.5-flash-lite',
  live: process.env.MODEL_LIVE || 'gemini-3.8-live',
  liveDeep: process.env.MODEL_LIVE_DEEP || 'gemini-3.8-live-extended-thinking',
  tts: process.env.MODEL_TTS || 'gemini-3.1-flash-tts-preview',
};

if (!KEY) {
  console.error('GEMINI_API_KEY is required (a Google AI Studio key).');
  process.exit(2);
}

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
};

/** The tolerant reader from gemini.ts, inlined so this script stays standalone. */
const textOf = (body) => {
  const out = [];
  for (const step of body?.steps ?? body?.outputs ?? []) {
    if (step?.type === 'thought') continue;
    const content = step?.content ?? step?.parts ?? [];
    for (const block of Array.isArray(content) ? content : [content]) {
      if (block?.type === 'thought') continue;
      if (typeof block?.text === 'string') out.push(block.text);
    }
    if (typeof step?.text === 'string') out.push(step.text);
  }
  if (!out.length && typeof body?.output_text === 'string') out.push(body.output_text);
  return out.join('').trim();
};

const thinkingLevel = (model, intent) => {
  const bare = model.replace(/^models\//, '');
  const table = [
    [/^gemini-3\.1-pro\b/, ['low', 'high']],
    [/^gemini-3\.[78]-flash\b/, ['low', 'medium', 'high']],
    [/^gemini-3(\.\d+)?-flash(-lite)?\b/, ['minimal', 'low', 'medium', 'high']],
  ].find(([re]) => re.test(bare));
  if (!table) return undefined;
  const wanted = { bulk: 'minimal', balanced: 'low', deep: 'high' }[intent] ?? intent;
  const levels = table[1];
  if (levels.includes(wanted)) return wanted;
  return levels.includes('low') ? 'low' : levels[0];
};

// ---------------------------------------------------------------- HTTP checks

async function checkPlainTurn() {
  const r = await post('/interactions', {
    model: MODELS.tutor,
    input: 'Reply with exactly: おはよう (and nothing else).',
    system_instruction: 'You are a Japanese tutor. Answer in one short sentence.',
    generation_config: { thinking_level: thinkingLevel(MODELS.tutor, 'balanced') },
  });
  const text = textOf(r.json);
  record('interactions · plain turn (system_instruction + thinking_level)',
    r.status === 200 && text.length > 0,
    r.status === 200 ? `status=${r.json?.status} text=${JSON.stringify(text.slice(0, 40))}` : r.text.slice(0, 200));
  return r.json?.id;
}

async function checkStructured() {
  const schema = {
    type: 'object',
    properties: {
      reading: { type: 'string' },
      meaningEN: { type: 'string' },
      pos: { type: 'string', enum: ['noun', 'verb', 'adjective', 'other'] },
      examples: { type: 'array', items: { type: 'string' } },
    },
    required: ['reading', 'meaningEN', 'pos', 'examples'],
  };
  const r = await post('/interactions', {
    model: MODELS.fast,
    input: 'Give a dictionary entry for 図書館 (library). JSON only.',
    response_format: { type: 'text', mime_type: 'application/json', schema },
    generation_config: { thinking_level: thinkingLevel(MODELS.fast, 'bulk'), max_output_tokens: 8192 },
  });
  let parsed;
  try { parsed = JSON.parse(textOf(r.json)); } catch { /* reported below */ }
  record('interactions · structured output (response_format.schema)',
    r.status === 200 && Boolean(parsed?.reading),
    r.status === 200 ? `keys=${parsed ? Object.keys(parsed).join(',') : 'unparseable'}` : r.text.slice(0, 200));
}

async function checkChainedTurn(firstId) {
  if (!firstId) return record('interactions · previous_interaction_id', false, 'no id from the first call');
  const r = await post('/interactions', {
    model: MODELS.tutor,
    input: 'What did I ask you to say? One short line.',
    previous_interaction_id: firstId,
  });
  const text = textOf(r.json);
  record('interactions · previous_interaction_id keeps the thread',
    r.status === 200 && /おはよう/.test(text),
    r.status === 200 ? `text=${JSON.stringify(text.slice(0, 60))}` : r.text.slice(0, 200));
}

async function checkPlanner() {
  const r = await post('/interactions', {
    model: MODELS.planner,
    input: 'Return one JSON object: {"sessions": 2, "why": "one clause"}. JSON only.',
    system_instruction: 'You plan Japanese tutoring sessions.',
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: {
        type: 'object',
        properties: { sessions: { type: 'integer', minimum: 1, maximum: 5 }, why: { type: 'string' } },
        required: ['sessions', 'why'],
      },
    },
    generation_config: { thinking_level: thinkingLevel(MODELS.planner, 'deep'), max_output_tokens: 8192 },
  });
  let parsed;
  try { parsed = JSON.parse(textOf(r.json)); } catch { /* reported below */ }
  record(`interactions · reasoning model (${MODELS.planner}) with high thinking`,
    r.status === 200 && parsed?.sessions > 0,
    r.status === 200 ? `status=${r.json?.status} sessions=${parsed?.sessions}` : r.text.slice(0, 300));
}

async function checkTts() {
  const r = await post('/interactions', {
    model: MODELS.tts,
    input: 'Say cheerfully: おはようございます。',
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: 'Aoede' }] },
  });
  const blocks = [];
  for (const step of r.json?.steps ?? r.json?.outputs ?? []) {
    const content = step?.content ?? step?.parts ?? [];
    blocks.push(...(Array.isArray(content) ? content : [content]));
  }
  const audio = blocks.find((b) => b?.type === 'audio' && b?.data);
  record('interactions · TTS (response_format audio + speech_config list)',
    r.status === 200 && Boolean(audio?.data),
    r.status === 200 ? `bytes≈${audio ? Math.round(audio.data.length * 0.75) : 0} mime=${audio?.mime_type}` : r.text.slice(0, 200));
}

async function checkNegativeControl() {
  const r = await post('/interactions', {
    model: MODELS.tutor,
    input: 'hi',
    response_schema: { type: 'object', properties: { x: { type: 'string' } } },
  });
  const message = r.json?.error?.message ?? r.text;
  record('negative control · the original bug is still a hard 400',
    r.status === 400 && /response_schema|Unknown/i.test(message),
    `${r.status} ${String(message).slice(0, 120)}`);
}

// ---------------------------------------------------------------- Live checks

/**
 * One live socket, one setup frame, one expected outcome.
 * `expect: 'reject'` inverts the verdict: the socket must close before setupComplete
 * (models differ on thinkingConfig and on blocking tools, and both halves of the
 * difference deserve a check — a config that "works" because the server ignores it is
 * how the last round of silent failures happened).
 */
function liveCheck(name, model, thinking, opts = {}) {
  const expectRejection = opts.expect === 'reject';
  return new Promise((resolve) => {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(KEY)}`;
    const ws = new WebSocket(url);
    const settled = (accepted, detail) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      record(name, accepted !== expectRejection, detail);
      resolve();
    };
    const timer = setTimeout(() => {
      settled(false, expectRejection ? 'no rejection — the setup stayed open' : 'timed out before setupComplete');
    }, 20_000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { languageCode: 'ja-JP', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
            ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
          },
          systemInstruction: { parts: [{ text: 'You are a Japanese tutor. Say こんにちは and stop.' }] },
          realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 1800 } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          ...(opts.tools
            ? {
              tools: [{
                functionDeclarations: [{
                  name: 'finish_beat',
                  description: 'Say the activity is finished.',
                  // The thinking model runs tools in the background and errors on
                  // blocking declarations; plain models leave the field off.
                  ...(opts.nonBlocking ? { behavior: 'NON_BLOCKING' } : {}),
                  parameters: { type: 'object', properties: { met: { type: 'boolean' } }, required: ['met'] },
                }],
              }],
            }
            : {}),
          sessionResumption: {},
          contextWindowCompression: { slidingWindow: {} },
        },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
      if (msg.setupComplete) return settled(true, `${model} accepted${thinking ? ` (thinkingLevel=${thinking})` : ' (no thinkingConfig)'}`);
      if (msg.goAway) return settled(false, `goAway: ${msg.goAway.timeLeft}`);
    });
    ws.addEventListener('close', (ev) => settled(false, `closed ${ev.code} ${ev.reason || ''}`.trim()));
    ws.addEventListener('error', () => settled(false, 'socket error'));
  });
}

// ---------------------------------------------------------------- run

console.log(`base: ${BASE}`);
console.log(`models: ${Object.entries(MODELS).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);

if (!flag('--live-only')) {
  const id = await checkPlainTurn();
  await checkStructured();
  await checkChainedTurn(id);
  await checkPlanner();
  await checkTts();
  await checkNegativeControl();
}

await liveCheck(`live · ${MODELS.live} (no thinkingConfig, blocking tools)`, MODELS.live, undefined, { tools: true });
await liveCheck(
  `live · ${MODELS.liveDeep} (thinkingLevel=low, NON_BLOCKING tools)`,
  MODELS.liveDeep,
  'low',
  { tools: true, nonBlocking: true },
);
if (!flag('--live-only')) {
  await liveCheck(
    'live · negative control (thinkingConfig on a model that rejects it)',
    MODELS.live,
    'low',
    { expect: 'reject' },
  );
  await liveCheck(
    'live · negative control (BLOCKING declaration on the thinking model)',
    MODELS.liveDeep,
    'low',
    { tools: true, nonBlocking: false, expect: 'reject' },
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
