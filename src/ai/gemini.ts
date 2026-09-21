/**
 * gemini.ts — Gemini 3.8 client for Workers.
 *
 * Written against the **Interactions API** (GA since June 2026, and the recommended
 * interface for all new projects — `generateContent` is now legacy). Two reasons we
 * want it specifically:
 *   · `previous_interaction_id` gives us server-side conversation state, which means
 *     better context-cache hit rates across a multi-turn tutoring session.
 *   · Execution steps are observable, so we can render "what the tutor is doing"
 *     in the UI and log tool calls for the learner model.
 *
 * Model routing (see wrangler.jsonc vars):
 *   planner  → gemini-3.1-pro-preview   (session design, placement synthesis, weekly review)
 *   tutor    → gemini-3.8-flash         (in-session turns, marking, item generation)
 *   fast     → gemini-3.5-flash-lite    (glosses, distractors, bulk enrichment)
 *   live     → gemini-3.8-live          (native speech-to-speech, 70+ languages)
 *   liveDeep → gemini-3.8-live-extended-thinking (placement interview — reasoning > latency)
 *   tts      → gemini-3.1-flash-tts-preview (audio for reading/listening/shadowing)
 *
 * All of it can be routed through **Cloudflare AI Gateway** by setting
 * CF_AI_GATEWAY_ACCOUNT + CF_AI_GATEWAY_ID (+ CF_AIG_TOKEN), which buys us logging,
 * caching, rate limiting, and BYOK key storage in Secrets Store instead of a raw key
 * in the Worker environment. Same code path either way.
 */

import type { Env } from '../types';

export interface ModelCall {
  model: string;
  input: string;
  system?: string;
  schema?: unknown;
  /** Server-side conversation state — pass the previous interaction id to continue a thread. */
  previousInteractionId?: string;
  store?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  background?: boolean;
  tools?: unknown[];
}

export interface ModelResult<T = unknown> {
  text: string;
  json?: T;
  interactionId?: string;
  model: string;
  usage?: { input?: number; output?: number };
  transport: 'gateway' | 'direct';
  ms: number;
  /** e.g. "STOP" | "MAX_TOKENS" — the reason the output ended, for honest errors. */
  finishReason?: string;
}

/** The API itself failed (HTTP error, unreachable host). Mapped to 502 by the worker. */
export class ModelCallError extends Error {
  readonly code = 'ai_call_failed' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ModelCallError';
  }
}

/** The API answered but we could not get usable structured output, even after the
 *  repair attempt. Mapped to 502 by the worker — never silently downgraded. */
export class ModelOutputError extends Error {
  readonly code = 'ai_output_invalid' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Output ceiling for structured calls that don't ask for a specific one. Generous on
 *  purpose: the reasoning planner thinks for thousands of tokens before it writes the
 *  first brace, and a truncated object is worth exactly nothing to the parser. */
const SCHEMA_OUTPUT_TOKENS = 16_384;

export function baseUrl(env: Env): { url: string; transport: 'gateway' | 'direct' } {
  if (env.CF_AI_GATEWAY_ACCOUNT && env.CF_AI_GATEWAY_ID) {
    return {
      url: `https://gateway.ai.cloudflare.com/v1/${env.CF_AI_GATEWAY_ACCOUNT}/${env.CF_AI_GATEWAY_ID}/google-ai-studio`,
      transport: 'gateway',
    };
  }
  return { url: env.GEMINI_BASE || DEFAULT_BASE, transport: 'direct' };
}

export function hasKey(env: Env): boolean {
  return Boolean(env.GEMINI_API_KEY) || Boolean(env.CF_AI_GATEWAY_ACCOUNT && env.CF_AI_GATEWAY_ID);
}

function headers(env: Env): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (env.CF_AI_GATEWAY_ACCOUNT && env.CF_AI_GATEWAY_ID) {
    // AI Gateway holds the Google key (BYOK in Secrets Store); the gateway token authorises us.
    if (env.CF_AIG_TOKEN) h['cf-aig-authorization'] = `Bearer ${env.CF_AIG_TOKEN}`;
    if (env.GEMINI_API_KEY) h['x-goog-api-key'] = env.GEMINI_API_KEY; // optional: pass through inline
  } else if (env.GEMINI_API_KEY) {
    h['x-goog-api-key'] = env.GEMINI_API_KEY;
  }
  return h;
}

/**
 * Tolerant text extraction: the API has shipped three response shapes since 2024 and
 * we would rather keep working than be pinned to one.
 *
 * Reasoning models interleave *thought* steps/summaries with the answer. Those are
 * excluded here: thought prose ahead of the JSON is the classic way a structured
 * reply turns into "non-JSON output" — the parser meets an argumentative brace from
 * the model's deliberation before it ever reaches the payload.
 */
export function extractText(body: any): { text: string; interactionId?: string; usage?: any; finishReason?: string } {
  if (!body) return { text: '' };
  const interactionId = body.id ?? body.interaction_id ?? body.interactionId;
  const usage = body.usage ?? body.usage_metadata ?? body.usageMetadata;
  const steps: any[] = body.steps ?? body.outputs ?? [];
  const lastStep = steps[steps.length - 1];
  const finishReason =
    body.finishReason ?? body.finish_reason
    ?? body.candidates?.[0]?.finishReason ?? body.candidates?.[0]?.finish_reason
    ?? lastStep?.finishReason ?? lastStep?.finish_reason ?? lastStep?.status;
  const isThought = (x: any) => x?.thought === true || x?.isThought === true || x?.type === 'thought';
  const chunks: string[] = [];
  const pushParts = (parts: any[]) => {
    for (const p of parts ?? []) {
      if (isThought(p)) continue; // reasoning summary, not answer text
      if (typeof p === 'string') chunks.push(p);
      else if (typeof p?.text === 'string') chunks.push(p.text);
      else if (typeof p?.output_text === 'string') chunks.push(p.output_text);
      else if (p?.text?.text) chunks.push(p.text.text);
    }
  };
  for (const step of body.steps ?? body.outputs ?? []) {
    if (isThought(step)) continue;
    if (typeof step?.text === 'string') chunks.push(step.text);
    if (typeof step?.output_text === 'string') chunks.push(step.output_text);
    pushParts(step?.content?.parts ?? step?.parts ?? step?.content ?? []);
  }
  if (body.candidates) for (const c of body.candidates) pushParts(c?.content?.parts ?? []);
  if (body.output) {
    if (typeof body.output === 'string') chunks.push(body.output);
    else if (!isThought(body.output)) pushParts(body.output?.content?.parts ?? body.output?.parts ?? []);
  }
  return { text: chunks.join('').trim(), interactionId, usage, finishReason };
}

/**
 * Strip fences / prose and grab the first parseable JSON value.
 *
 * Every opening brace/bracket is a candidate start, not just the first one: models
 * annotate before they answer ("skills{listening: ...}" pseudo-notation, worked
 * examples, thought summaries that slipped through), and the first brace in such
 * output is almost never the payload. Unparseable candidates are skipped, the first
 * balanced-and-parseable one wins. Cheap on the sizes we deal with (tens of KB).
 */
export function parseJsonLoose(text: string): any | undefined {
  if (!text) return undefined;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* a fence can hold a fragment; keep digging below */ }
  }
  const scan = (s: string): any | undefined => {
    for (let first = 0; first < s.length; first++) {
      const openCh = s[first];
      if (openCh !== '{' && openCh !== '[') continue;
      const closeCh = openCh === '{' ? '}' : ']';
      let depth = 0, inStr = false, esc = false;
      for (let i = first; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === openCh) depth++;
        else if (ch === closeCh) { depth--; if (depth === 0) { try { return JSON.parse(s.slice(first, i + 1)); } catch { break; } } }
      }
    }
    return undefined;
  };
  return scan(t) ?? (fence ? scan(fence[1].trim()) : undefined);
}

export async function callModel(env: Env, call: ModelCall): Promise<ModelResult> {
  const { url, transport } = baseUrl(env);
  const started = Date.now();
  const body: Record<string, unknown> = {
    model: call.model,
    input: call.input,
  };
  // Response-schema keys must live inside generation_config — at the top level of the
  // request they are silently ignored, and an ignored schema is exactly how a reasoning
  // model ends up writing five thousand characters of beautiful, unparseable prose.
  const generationConfig: Record<string, unknown> = {};
  if (call.temperature !== undefined) generationConfig.temperature = call.temperature;
  if (call.schema) {
    generationConfig.response_mime_type = 'application/json';
    generationConfig.response_schema = call.schema;
    // Thinking models spend output budget reasoning *before* the JSON starts. With no
    // explicit ceiling the default one is easily consumed by thought alone and the
    // object gets cut off mid-way — which parses as nothing, every single time.
    generationConfig.max_output_tokens = call.maxOutputTokens ?? SCHEMA_OUTPUT_TOKENS;
  } else if (call.maxOutputTokens !== undefined) {
    generationConfig.max_output_tokens = call.maxOutputTokens;
  }
  if (Object.keys(generationConfig).length) body.generation_config = generationConfig;
  if (call.previousInteractionId) body.previous_interaction_id = call.previousInteractionId;
  if (call.store === false) body.store = false;
  if (call.background) body.background = true;
  if (call.schema) {
    // Also under the top-level keys some gateway generations have used; harmless if
    // ignored now that generation_config carries the real copy.
    body.response_format = { type: 'json_schema', json_schema: { name: 'result', schema: call.schema } };
    body.response_schema = call.schema;
    body.response_mime_type = 'application/json';
  }
  if (call.tools?.length) body.tools = call.tools;

  let res: Response;
  try {
    res = await fetch(`${url}/interactions`, {
      method: 'POST',
      headers: headers(env),
      body: JSON.stringify(body),
    });
  } catch (err) {
    // DNS/TLS/timeout: the model was never even reached. Same class of failure as an
    // HTTP error from its perspective — report it, never degrade silently.
    throw new ModelCallError(`gemini unreachable: ${(err as Error).message}`);
  }
  const raw = await res.text();
  if (!res.ok) {
    throw new ModelCallError(`gemini ${res.status}: ${raw.slice(0, 600)}`);
  }
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = { output_text: raw }; }
  const { text, interactionId, usage, finishReason } = extractText(parsed);
  return {
    text,
    json: call.schema ? parseJsonLoose(text) : undefined,
    interactionId,
    model: call.model,
    usage: usage ? { input: usage.input_tokens ?? usage.promptTokenCount, output: usage.output_tokens ?? usage.candidatesTokenCount } : undefined,
    transport,
    ms: Date.now() - started,
    finishReason,
  };
}

/**
 * Structured call with one automatic repair attempt. If the repair still does not
 * parse, this throws ModelOutputError — callers used to fall back to scripted
 * content here, which is exactly the silent degradation we removed.
 *
 * The repair is not a rerun of the same coin flip: it is colder *and* it doubles the
 * output ceiling, because the two realistic failure modes are (a) a reasoning model
 * narrating instead of answering and (b) the JSON being cut off mid-object — and
 * retrying (b) at the same ceiling reproduces it with impressive consistency.
 */
export async function callJSON<T>(env: Env, call: ModelCall): Promise<ModelResult<T>> {
  const first = await callModel(env, call);
  if (first.json) return first as ModelResult<T>;
  const repaired = await callModel(env, {
    ...call,
    input: `${call.input}\n\nYour previous reply was not valid JSON. Return ONLY the JSON object that satisfies the schema — no prose, no fences, no reasoning summary.`,
    temperature: 0,
    maxOutputTokens: Math.max(call.maxOutputTokens ?? 0, 2 * (call.maxOutputTokens ?? SCHEMA_OUTPUT_TOKENS)),
  });
  if (!repaired.json) {
    const describe = (r: ModelResult) => {
      const truncated = r.finishReason && !/stop|complete/i.test(r.finishReason);
      return truncated ? `${r.text.length} chars, ended "${r.finishReason}" (output likely cut off mid-JSON)` : `${r.text.length} chars`;
    };
    throw new ModelOutputError(
      `${call.model} returned non-JSON output twice (first ${describe(first)}, retry ${describe(repaired)}).`,
    );
  }
  return repaired as ModelResult<T>;
}

// ------------------------------------------------------------------ Live API (voice)

export const GEMINI_WS_HOST = 'wss://generativelanguage.googleapis.com';

export function liveWsUrl(env: Env, opts: { model: string; key?: string; token?: string }): string {
  const host = env.GEMINI_BASE?.includes('gateway.ai.cloudflare.com')
    ? 'wss://gateway.ai.cloudflare.com' // gateway also proxies the Live API for Google AI Studio keys
    : GEMINI_WS_HOST;
  const path = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  const cred = opts.token ? `access_token=${opts.token}` : `key=${opts.key ?? env.GEMINI_API_KEY ?? ''}`;
  return `${host}${path}?${cred}`;
}

/**
 * Short-lived, single-use token so the *browser* can talk to the Live API directly.
 * Lowest latency path, and the long-lived API key never reaches the client.
 * Server-to-server relay through LiveSessionDO is the alternative (see runtime/live.ts) —
 * we use the relay by default because it lets the DO handle tool calls and persist
 * transcript as it streams, and fall back to ephemeral tokens when latency matters most.
 */
export async function createEphemeralToken(env: Env, opts: { model: string; minutes?: number; systemInstruction?: string }): Promise<{ token: string; expiresAt: number; model: string; transport: string }> {
  const { url, transport } = baseUrl(env);
  const now = Date.now();
  const res = await fetch(`${url}/auth_tokens`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      uses: 1,
      expire_time: new Date(now + (opts.minutes ?? 30) * 60_000).toISOString(),
      new_session_expire_time: new Date(now + 120_000).toISOString(),
      ...(opts.systemInstruction ? { system_instruction: { parts: [{ text: opts.systemInstruction }] } } : {}),
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new ModelCallError(`auth_tokens ${res.status}: ${raw.slice(0, 400)}`);
  const body = JSON.parse(raw);
  const token = body.name ?? body.token ?? body.access_token;
  return { token, expiresAt: now + (opts.minutes ?? 30) * 60_000, model: opts.model, transport };
}

/**
 * Live setup message. The two settings that matter most for language learners:
 *   · generous VAD silence window — the model must not barge in while a learner is
 *     assembling a sentence. Real learners need 1.5–2.5s of thinking room.
 *   · barge-in enabled — they must be able to talk over the tutor, as with a human.
 * We also turn on input+output transcription: the transcript is the evidence that
 * feeds the learner model, and it gives the learner a text record to study.
 */
export function liveSetup(opts: {
  model: string;
  systemInstruction: string;
  voice?: string;
  languageCode?: string;
  tools?: unknown[];
  resumptionHandle?: string;
  silenceMs?: number;
}) {
  return {
    setup: {
      model: `models/${opts.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode: opts.languageCode ?? 'ja-JP',
          voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice ?? 'Aoede' } },
        },
      },
      systemInstruction: { parts: [{ text: opts.systemInstruction }] },
      // Turn-taking tuned for a learner, not a customer-service bot.
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          silenceDurationMs: opts.silenceMs ?? 1800,   // room to think
          prefixPaddingMs: 300,
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          startOfSpeechSensitivity: 'START_SENSITIVITY_MEDIUM',
        },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS', // barge-in allowed
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...(opts.tools?.length ? { tools: [{ functionDeclarations: opts.tools }] } : {}),
      ...(opts.resumptionHandle ? { sessionResumption: { handle: opts.resumptionHandle } } : { sessionResumption: {} }),
      // Long sessions shouldn't die on context. Sliding window keeps a 90-minute
      // immersion session alive without ballooning cost.
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

/** Tools the *voice* tutor can call mid-sentence, without breaking the conversation.
 *  Handled inside LiveSessionDO, not the browser, so the learner model is written
 *  even if the tab dies. */
export const LIVE_TOOLS = [
  {
    name: 'log_error',
    description: 'Log a language error the learner just made, for their learning model. Use silently; do not tell them you are logging it.',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'taxonomy tag e.g. particle.wa_ga, verb.te_form, keigo.humble, pron.pitch, interaction.aizuchi' },
        quote: { type: 'string', description: 'what the learner said' },
        recast: { type: 'string', description: 'natural corrected version' },
        severity: { type: 'number' },
      },
      required: ['tag', 'quote'],
    },
  },
  {
    name: 'lookup_item',
    description: 'Look up whether an item is already in the learner’s memory deck and how well they know it. Use to decide whether to pre-teach.',
    parameters: { type: 'object', properties: { surface: { type: 'string' } }, required: ['surface'] },
  },
  {
    name: 'add_to_review',
    description: 'Add an item to the learner’s spaced-repetition queue because it came up and is worth keeping.',
    parameters: {
      type: 'object',
      properties: { surface: { type: 'string' }, reading: { type: 'string' }, meaning: { type: 'string' }, kind: { type: 'string' } },
      required: ['surface'],
    },
  },
  {
    name: 'note_for_next_session',
    description: 'Write a private note for your future self when planning the next session.',
    parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  },
  {
    name: 'finish_beat',
    description: 'Call when the current activity’s objective has been met or clearly is not going to be met.',
    parameters: {
      type: 'object',
      properties: { met: { type: 'boolean' }, because: { type: 'string' } },
      required: ['met'],
    },
  },
];

// ------------------------------------------------------------------ TTS

/**
 * Japanese audio for reading / listening / shadowing.
 *
 * Quality path: Gemini TTS (gemini-3.1-flash-tts-preview) — native Japanese prosody,
 * which matters because we are teaching pitch and mora timing.
 * Fallback path: the browser's own ja-JP speech synthesis (client-side, free, instant)
 * — used automatically when no key is configured, and for tap-to-hear individual words,
 * where the latency of a round trip is worse than slightly robotic output.
 *
 * Note: Workers AI has excellent STT (@cf/deepgram/nova-3, @cf/openai/whisper-large-v3-turbo)
 * but its TTS models (Deepgram Aura 1/2) are English/Spanish only — so Japanese audio
 * deliberately does not go through Workers AI.
 */
export async function synthesize(
  env: Env,
  text: string,
  opts: { voice?: string; speed?: number } = {},
): Promise<{ audioBase64: string; mimeType: string } | null> {
  if (!hasKey(env)) return null;
  const { url } = baseUrl(env);
  const res = await fetch(`${url}/interactions`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      model: env.MODEL_TTS || 'gemini-3.1-flash-tts-preview',
      input: text,
      response_modalities: ['audio'],
      generation_config: {
        speech_config: { language_code: 'ja-JP', voice_config: { prebuilt_voice_config: { voice_name: opts.voice ?? 'Aoede' } } },
        ...(opts.speed ? { speaking_rate: opts.speed } : {}),
      },
    }),
  });
  if (!res.ok) return null;
  const body: any = await res.json();
  const parts: any[] = [];
  for (const step of body.steps ?? body.outputs ?? []) parts.push(...(step?.content?.parts ?? step?.parts ?? []));
  for (const c of body.candidates ?? []) parts.push(...(c?.content?.parts ?? []));
  const audio = parts.find((p) => p?.inlineData?.data ?? p?.inline_data?.data);
  if (!audio) return null;
  const inline = audio.inlineData ?? audio.inline_data;
  return { audioBase64: inline.data, mimeType: inline.mimeType ?? inline.mime_type ?? 'audio/L16;rate=24000' };
}

export const MODEL_FOR = (env: Env, role: 'planner' | 'tutor' | 'fast' | 'live' | 'liveDeep' | 'tts'): string => {
  const map: Record<string, string | undefined> = {
    planner: env.MODEL_PLANNER,
    tutor: env.MODEL_TUTOR,
    fast: env.MODEL_FAST,
    live: env.MODEL_LIVE,
    liveDeep: env.MODEL_LIVE_DEEP,
    tts: env.MODEL_TTS,
  };
  const fallback: Record<string, string> = {
    planner: 'gemini-3.1-pro-preview',
    tutor: 'gemini-3.8-flash',
    fast: 'gemini-3.5-flash-lite',
    live: 'gemini-3.8-live',
    liveDeep: 'gemini-3.8-live-extended-thinking',
    tts: 'gemini-3.1-flash-tts-preview',
  };
  return map[role] || fallback[role];
};
