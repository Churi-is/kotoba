/**
 * gemini.ts — Gemini client for Workers, written against the **Interactions API**
 * (`POST /v1beta/interactions`), which is the recommended interface for new code;
 * `generateContent` is legacy now.
 *
 * Everything in this file was checked against the live docs on 2026-09-21 — the raw
 * request shapes matter because this API validates strictly and answers with
 * `400 {"error":{"code":"invalid_request","message":"Unknown parameter 'x'"}}`
 * rather than ignoring a field it does not know. The notes that keep biting us:
 *
 *   · Structured output is NOT `response_schema` / `response_mime_type` any more
 *     (removed in the May 2026 revision). It is one polymorphic field:
 *       "response_format": { "type": "text", "mime_type": "application/json", "schema": {...} }
 *     `generation_config` carries model behaviour only (max_output_tokens, thinking_level,
 *     speech_config, tool_choice) — and no `temperature`: the Gemini 3.x family ignores
 *     sampling knobs and future generations reject them outright.
 *   · `system_instruction` is a top-level field of the request. Hands up: the previous
 *     version of this file accepted a `system` argument and silently dropped it.
 *   · Model behaviour params are interaction-scoped: when you chain turns with
 *     `previous_interaction_id`, `system_instruction`, `tools` and `generation_config`
 *     must be re-sent on every call. `previous_interaction_id` only carries the history,
 *     and it requires `store` (the default) — `store: false` breaks it.
 *   · Responses are a `steps` timeline (`model_output`, `thought`, `function_call`,
 *     `user_input`), not `candidates`. `status: "incomplete"` means the output was cut
 *     off — which for a JSON call means "no object", every single time.
 *   · `max_output_tokens` is a *combined* budget for thoughts + answer, so a truncated
 *     structured call is fixed by thinking less, not by asking for more tokens alone.
 *
 * Model routing (see wrangler.jsonc vars):
 *   planner  → gemini-3.1-pro-preview   (session design, placement synthesis, weekly review)
 *   tutor    → gemini-3.8-flash         (in-session turns, marking, item generation)
 *   fast     → gemini-3.5-flash-lite    (glosses, distractors, bulk enrichment)
 *   live     → gemini-3.8-live          (native speech-to-speech, 70+ languages)
 *   liveDeep → gemini-3.8-live-extended-thinking (placement interview — reasoning > latency)
 *   tts      → gemini-3.1-flash-tts-preview (audio for reading/listening/shadowing)
 *
 * The Live API is a separate protocol (WebSocket, `BidiGenerateContent`) with its own
 * rules; the two that are easy to get wrong are in liveSetup() and liveSocket().
 *
 * All HTTP calls can be routed through **Cloudflare AI Gateway** (CF_AI_GATEWAY_ACCOUNT
 * + CF_AI_GATEWAY_ID [+ CF_AIG_TOKEN]); the gateway takes the same paths, one segment
 * deeper (`/v1beta/...`), and can hold the Google key in Secrets Store instead of the
 * Worker environment.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/structured-output ·
 *       https://ai.google.dev/api/interactions-api-v1 ·
 *       https://ai.google.dev/api/live ·
 *       https://ai.google.dev/gemini-api/docs/interactions-breaking-changes-may-2026
 */

import type { Env } from '../types';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
/** What we actually want, per call site: a level, or an intent the table resolves. */
export type ThinkingIntent = ThinkingLevel | 'bulk' | 'balanced' | 'deep';

export interface ModelCall {
  model: string;
  input: string;
  /** System instruction — sent as top-level `system_instruction`. */
  system?: string;
  schema?: unknown;
  /** Server-side conversation state — pass the previous interaction id to continue a thread. */
  previousInteractionId?: string;
  store?: boolean;
  /** How hard the model should think before answering. Resolved per model. */
  thinking?: ThinkingIntent;
  maxOutputTokens?: number;
  background?: boolean;
  /** Function declarations (Live-style `{name, description, parameters}`). */
  tools?: unknown[];
}

export interface ModelResult<T = unknown> {
  text: string;
  json?: T;
  interactionId?: string;
  model: string;
  usage?: { input?: number; output?: number; thoughts?: number };
  transport: 'gateway' | 'direct';
  ms: number;
  /** e.g. "completed" | "incomplete" | "MAX_TOKENS" — the reason the output ended. */
  finishReason?: string;
}

/** The API itself failed (HTTP error, unreachable host, unusable API key). Mapped to 502. */
export class ModelCallError extends Error {
  readonly code = 'ai_call_failed' as const;
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ModelCallError';
    this.status = status;
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
 *  purpose: `max_output_tokens` pays for thoughts *and* the answer, and a truncated
 *  object is worth exactly nothing to the parser. */
const SCHEMA_OUTPUT_TOKENS = 32_768;

export function baseUrl(env: Env): { url: string; transport: 'gateway' | 'direct' } {
  if (env.CF_AI_GATEWAY_ACCOUNT && env.CF_AI_GATEWAY_ID) {
    // Provider base, then the Google API version segment: the gateway proxies paths
    // verbatim, so omitting /v1beta here is a 404 on every call.
    return {
      url: `https://gateway.ai.cloudflare.com/v1/${env.CF_AI_GATEWAY_ACCOUNT}/${env.CF_AI_GATEWAY_ID}/google-ai-studio/v1beta`,
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
    // AI Gateway can hold the Google key (BYOK in Secrets Store); the gateway token auths us.
    if (env.CF_AIG_TOKEN) h['cf-aig-authorization'] = `Bearer ${env.CF_AIG_TOKEN}`;
    if (env.GEMINI_API_KEY) h['x-goog-api-key'] = env.GEMINI_API_KEY; // optional: pass through inline
  } else if (env.GEMINI_API_KEY) {
    h['x-goog-api-key'] = env.GEMINI_API_KEY;
  }
  return h;
}

// ------------------------------------------------------------------ thinking levels

/**
 * Which thinking levels each model family accepts. Getting this wrong is not a
 * degraded answer, it is a 400 or a closed socket, so the table is explicit and a
 * model we do not recognise gets **no** level at all (the default is always valid):
 *
 *   · gemini-3.1-pro-*            low | high            (medium is a 400; default high)
 *   · gemini-3.7/3.8-flash        low | medium | high   (minimal became a 400 at 3.7)
 *   · gemini-3.x-flash(-lite)     minimal … high        (flash-lite defaults to minimal)
 *   · gemini-2.x                  no `thinking_level` — those take `thinking_budget`,
 *                                 and sending a level is an invalid argument
 */
const THINKING_BY_MODEL: { match: RegExp; levels: ThinkingLevel[] }[] = [
  { match: /^gemini-3\.1-pro\b/, levels: ['low', 'high'] },
  { match: /^gemini-3\.[78]-flash\b/, levels: ['low', 'medium', 'high'] },
  { match: /^gemini-3(\.\d+)?-flash(-lite)?\b/, levels: ['minimal', 'low', 'medium', 'high'] },
];

const THINKING_INTENT: Record<'bulk' | 'balanced' | 'deep', ThinkingLevel> = {
  bulk: 'minimal',
  balanced: 'low',
  deep: 'high',
};

function isLevel(x: ThinkingIntent): x is ThinkingLevel {
  return x === 'minimal' || x === 'low' || x === 'medium' || x === 'high';
}

export function thinkingLevelFor(model: string, intent: ThinkingIntent): ThinkingLevel | undefined {
  const bare = model.replace(/^models\//, '');
  const row = THINKING_BY_MODEL.find((r) => r.match.test(bare));
  if (!row) return undefined;
  if (isLevel(intent) && row.levels.includes(intent)) return intent;
  const want = THINKING_INTENT[intent as 'bulk' | 'balanced' | 'deep'] ?? 'low';
  if (row.levels.includes(want)) return want;
  return row.levels.includes('low') ? 'low' : row.levels[0];
}

// ------------------------------------------------------------------ request building

/**
 * Gemini's structured-output mode implements a documented *subset* of JSON Schema and
 * its validator is strict about what it will accept. We rebuild the schema from the
 * supported keywords only — an unknown keyword costs a 400 on the whole request — and
 * repair the two shapes that models/JS produce constantly:
 *   · an `array` with no `items` (rejected: "items: missing field")
 *   · `required` naming a property that isn't declared
 */
const SCHEMA_KEYS = new Set([
  'type', 'description', 'title', 'nullable', 'enum', 'format',
  'properties', 'required', 'additionalProperties',
  'items', 'prefixItems', 'minItems', 'maxItems',
  'minimum', 'maximum',
]);

export function sanitizeSchema(node: any): any {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!node || typeof node !== 'object') return node;

  // A $ref without its $defs would silently become an empty schema, which is worse
  // than a clear failure: it changes what the model is asked to produce.
  for (const key of Object.keys(node)) {
    if (key === '$ref' || key === '$defs' || key === 'definitions') {
      throw new Error(
        `structured output cannot use ${key}: Gemini's schema subset has no references. Inline the schema instead.`,
      );
    }
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties') {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries((v ?? {}) as Record<string, unknown>)) props[name] = sanitizeSchema(sub);
      out.properties = props;
    } else if (k === 'additionalProperties') {
      out.additionalProperties = typeof v === 'object' && v ? sanitizeSchema(v) : v;
    } else if (k === 'items' || k === 'prefixItems') {
      out[k] = sanitizeSchema(v);
    } else {
      out[k] = v;
    }
  }

  // An array type must declare items; an empty schema means "anything".
  const type = out.type;
  const isArray = type === 'array' || (Array.isArray(type) && type.includes('array'));
  if (isArray && out.items === undefined && out.prefixItems === undefined) out.items = {};

  if (Array.isArray(out.required) && out.properties) {
    const declared = new Set(Object.keys(out.properties as Record<string, unknown>));
    out.required = (out.required as unknown[]).filter((r) => typeof r === 'string' && declared.has(r));
  }

  return out;
}

/** Live-style declarations (`{name, description, parameters}`) → Interaction tools. */
function toInteractionTools(tools: unknown[]): unknown[] {
  return tools.map((t: any) => {
    if (t?.type) return t; // already an Interaction tool block (google_search, function …)
    return {
      type: 'function',
      name: t?.name,
      description: t?.description,
      parameters: sanitizeSchema(t?.parameters ?? { type: 'object', properties: {} }),
    };
  });
}

/**
 * Live function declarations, schema-cleaned.
 *
 * `behavior: 'NON_BLOCKING'` is not decoration: the extended-thinking model runs tools
 * asynchronously in the background while it keeps talking, and the docs are explicit
 * that a *synchronous* (blocking) declaration is an error there. Plain Live models are
 * fine either way, so the field is added only where it is required.
 */
function toFunctionDeclarations(tools: unknown[], nonBlocking = false): unknown[] {
  return tools.map((t: any) => ({
    name: t?.name,
    description: t?.description,
    ...(nonBlocking ? { behavior: 'NON_BLOCKING' } : {}),
    parameters: sanitizeSchema(t?.parameters ?? { type: 'object', properties: {} }),
  }));
}

// ------------------------------------------------------------------ response parsing

interface Extracted {
  text: string;
  interactionId?: string;
  usage?: { input?: number; output?: number; thoughts?: number };
  finishReason?: string;
}

const isThought = (x: any) => x?.thought === true || x?.isThought === true || x?.type === 'thought';
/** A step that carries the model's *answer* (as opposed to its deliberation or a tool call).
 *  Whitelist on purpose: a thought step under a name we have not seen yet must not be
 *  mistaken for the answer, and reasoning prose ahead of the JSON is how a structured
 *  reply turns into "no JSON found". */
const isAnswerStep = (x: any) =>
  x?.type === undefined || x?.type === 'model_output' || x?.type === 'modelOutput' || x?.type === 'message';
/** Text blocks only — same reasoning as isAnswerStep, from the other direction. */
const isTextBlock = (x: any) =>
  !isThought(x)
  && (typeof x === 'string'
    || typeof x?.text === 'string'
    || typeof x?.text?.text === 'string'
    || typeof x?.output_text === 'string');

/**
 * Tolerant text extraction across the API generations we have lived through:
 * Interactions (`steps` → `model_output` → content blocks), the pre-May-2026
 * `outputs` array, the `output_text` convenience property, and legacy
 * generateContent `candidates`. Thought blocks are skipped — reasoning prose ahead of
 * the JSON is the classic way a structured reply becomes "non-JSON output".
 */
export function extractText(body: any): Extracted {
  if (!body) return { text: '' };
  const interactionId = body.id ?? body.interaction_id ?? body.interactionId;
  const usage = body.usage ?? body.usage_metadata ?? body.usageMetadata;
  const steps: any[] = body.steps ?? body.outputs ?? [];
  const lastStep = steps[steps.length - 1];
  const finishReason =
    body.status
    ?? body.finishReason ?? body.finish_reason
    ?? body.candidates?.[0]?.finishReason ?? body.candidates?.[0]?.finish_reason
    ?? lastStep?.status ?? lastStep?.finishReason ?? lastStep?.finish_reason;

  const chunks: string[] = [];
  const pushParts = (parts: any[]) => {
    for (const p of parts ?? []) {
      if (!isTextBlock(p)) continue;                    // reasoning summary, tool call, audio …
      if (typeof p === 'string') chunks.push(p);
      else if (typeof p?.text === 'string') chunks.push(p.text);   // {type:'text', text}
      else if (typeof p?.text?.text === 'string') chunks.push(p.text.text);
      else if (typeof p?.output_text === 'string') chunks.push(p.output_text);
    }
  };

  for (const step of steps) {
    if (isThought(step) || !isAnswerStep(step)) continue;
    if (typeof step?.text === 'string') chunks.push(step.text);
    if (typeof step?.output_text === 'string') chunks.push(step.output_text);
    const content = step?.content ?? step?.parts ?? [];
    pushParts(Array.isArray(content) ? content : [content]);
  }
  if (!chunks.length && typeof body.output_text === 'string') chunks.push(body.output_text);
  if (body.candidates) for (const c of body.candidates) pushParts(c?.content?.parts ?? []);
  if (body.output) {
    if (typeof body.output === 'string') chunks.push(body.output);
    else if (!isThought(body.output)) pushParts(body.output?.content?.parts ?? body.output?.parts ?? []);
  }

  return {
    text: chunks.join('').trim(),
    interactionId,
    usage: usage ? {
      input: usage.total_input_tokens ?? usage.input_tokens ?? usage.promptTokenCount,
      output: usage.total_output_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount,
      thoughts: usage.total_thought_tokens,
    } : undefined,
    finishReason,
  };
}

/**
 * Audio out of an Interactions response. TTS comes back as an `audio` content block
 * (`{type:'audio', data, mime_type, sample_rate}`); older shapes put the same bytes in
 * an `inline_data` part. Both are handled because the payload is expensive to re-ask for.
 */
export function extractAudio(body: any): { audioBase64: string; mimeType: string } | undefined {
  const blocks: any[] = [];
  for (const step of body?.steps ?? body?.outputs ?? []) {
    const content = step?.content ?? step?.parts ?? [];
    blocks.push(...(Array.isArray(content) ? content : [content]));
  }
  for (const c of body?.candidates ?? []) blocks.push(...(c?.content?.parts ?? []));
  if (body?.output_audio) blocks.push(body.output_audio);
  if (body?.output) blocks.push(body.output);

  for (const b of blocks) {
    const inline = b?.inline_data ?? b?.inlineData;
    if (inline?.data) return { audioBase64: inline.data, mimeType: inline.mime_type ?? inline.mimeType ?? 'audio/l16;rate=24000' };
    if (b?.type === 'audio' && b.data) {
      const rate = b.sample_rate ? `;rate=${b.sample_rate}` : '';
      return { audioBase64: b.data, mimeType: b.mime_type ?? `audio/l16${rate}` };
    }
    if (typeof b?.data === 'string' && /^audio\//.test(b?.mime_type ?? '')) {
      return { audioBase64: b.data, mimeType: b.mime_type };
    }
  }
  return undefined;
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
  const t = text.trim();
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

/** "incomplete"/MAX_TOKENS means the answer was cut off; "completed"/STOP means it finished. */
function isTruncated(reason?: string): boolean {
  if (!reason) return false;
  return /incomplete|max_tokens|max tokens|length|truncat/i.test(reason);
}

/**
 * The API's error envelope, turned into something a human can act on:
 *   {"error":{"code":"invalid_request","message":"Unknown parameter 'response_schema'."}}
 */
function describeError(status: number, raw: string): string {
  let code = '';
  let message = raw.slice(0, 600);
  try {
    const j = JSON.parse(raw);
    code = j?.error?.code ?? j?.error?.status ?? '';
    message = j?.error?.message ?? message;
  } catch { /* not JSON — keep the raw text */ }
  const hint = /parameter_unknown|Unknown parameter|Unknown name/i.test(`${code} ${message}`)
    ? ' (the Interactions API rejects unknown fields instead of ignoring them — check names against https://ai.google.dev/api/interactions-api-v1)'
    : '';
  return `gemini ${status}${code ? ` ${code}` : ''}: ${message}${hint}`;
}

// ------------------------------------------------------------------ the call itself

/**
 * The request body, exactly as it goes on the wire. Split out from callModel so the
 * shape can be asserted without a key (`npm run check:shapes`) — this is the part that
 * produced `400 Unknown parameter 'response_schema'` and it should never be guesswork.
 */
export function interactionBody(call: ModelCall): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: call.model,
    input: call.input,
  };
  // System instructions are interaction-scoped: re-sent on every turn, including when
  // chaining with previous_interaction_id.
  if (call.system) body.system_instruction = call.system;

  if (call.schema) {
    body.response_format = {
      type: 'text',
      mime_type: 'application/json',
      schema: sanitizeSchema(call.schema),
    };
  }

  const generationConfig: Record<string, unknown> = {};
  const level = call.thinking ? thinkingLevelFor(call.model, call.thinking) : undefined;
  if (level) generationConfig.thinking_level = level;
  if (call.schema) {
    generationConfig.max_output_tokens = call.maxOutputTokens ?? SCHEMA_OUTPUT_TOKENS;
  } else if (call.maxOutputTokens !== undefined) {
    generationConfig.max_output_tokens = call.maxOutputTokens;
  }
  if (Object.keys(generationConfig).length) body.generation_config = generationConfig;

  // The API rejects this combination outright — "store must be true when
  // previous_interaction_id is set" (400) — so chaining wins over store:false.
  if (call.previousInteractionId) body.previous_interaction_id = call.previousInteractionId;
  if (call.store === false && !call.previousInteractionId) body.store = false;
  if (call.background) body.background = true;
  if (call.tools?.length) body.tools = toInteractionTools(call.tools);
  return body;
}

export async function callModel(env: Env, call: ModelCall): Promise<ModelResult> {
  const { url, transport } = baseUrl(env);
  const started = Date.now();
  const body = interactionBody(call);

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
  if (!res.ok) throw new ModelCallError(describeError(res.status, raw), res.status);

  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = { output_text: raw }; }
  const { text, interactionId, usage, finishReason } = extractText(parsed);
  return {
    text,
    json: call.schema ? parseJsonLoose(text) : undefined,
    interactionId,
    model: call.model,
    usage,
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
 * The repair is not a rerun of the same coin flip. The two realistic failure modes are
 * (a) a reasoning model narrating instead of answering and (b) the JSON being cut off
 * mid-object, and the API's own guidance for (b) is to *think less*, because
 * `max_output_tokens` is a combined budget for thoughts and answer. So the retry asks
 * for the cheapest thinking level the model accepts and raises the ceiling on top.
 */
export async function callJSON<T>(env: Env, call: ModelCall): Promise<ModelResult<T>> {
  const jsonOf = (r: ModelResult) => (r.json ?? parseJsonLoose(r.text)) as T | undefined;

  const first = await callModel(env, call);
  const firstJson = jsonOf(first);
  if (firstJson !== undefined) return { ...first, json: firstJson };

  // A truncated object is fixed by thinking less (thoughts and answer share the
  // max_output_tokens budget), so the retry asks for the cheapest level the model
  // takes and raises the ceiling on top of that.
  const needed = Math.max(call.maxOutputTokens ?? 0, first.text.length * 2, SCHEMA_OUTPUT_TOKENS);
  const repaired = await callModel(env, {
    ...call,
    input: `${call.input}\n\nYour previous reply was not valid JSON. Return ONLY the JSON object asked for — no prose, no fences, no reasoning summary.`,
    thinking: 'low',
    maxOutputTokens: isTruncated(first.finishReason) ? needed : call.maxOutputTokens,
  });
  const repairedJson = jsonOf(repaired);
  if (repairedJson === undefined) {
    const describe = (r: ModelResult) => {
      const chars = r.text.length ? `${r.text.length} chars` : 'no text at all';
      return isTruncated(r.finishReason)
        ? `${chars}, ended "${r.finishReason}" (output cut off before the JSON closed)`
        : `${chars}`;
    };
    throw new ModelOutputError(
      `${call.model} returned no parseable JSON twice (first ${describe(first)}, retry ${describe(repaired)}).`,
    );
  }
  return { ...repaired, json: repairedJson };
}

// ------------------------------------------------------------------ Live API (voice)

/**
 * Two sockets, and picking the wrong one is a hard failure:
 *   · long-lived API key            → BidiGenerateContent
 *   · short-lived ephemeral token   → BidiGenerateContentConstrained
 * (The token is passed as `access_token`, the key as `key`.)
 */
const WS_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const WS_PATH_CONSTRAINED = `${WS_PATH}Constrained`;
const WS_HOST = 'wss://generativelanguage.googleapis.com';

export interface LiveSocketTarget {
  url: string;
  /** Extra headers for the upgrade request (gateway auth, or the key when we can send one). */
  headers: Record<string, string>;
}

/**
 * Where to dial the voice model.
 *
 * Direct is the normal path. With AI Gateway configured we go through it — the
 * provider segment is `google` (not `google-ai-studio`) and the Google key travels as
 * `api_key` in the query, with the gateway token in a header (Workers can send real
 * headers on an upgrade request; browsers would use the `cf-aig-authorization.<token>`
 * subprotocol instead). Ephemeral tokens always go direct: the constrained endpoint is
 * not a gateway route, and the token is single-use anyway.
 */
export function liveSocket(env: Env, opts: { model: string; token?: string }): LiveSocketTarget {
  if (opts.token) {
    return {
      url: `${WS_HOST}${WS_PATH_CONSTRAINED}?access_token=${encodeURIComponent(opts.token)}`,
      headers: {},
    };
  }
  if (env.CF_AI_GATEWAY_ACCOUNT && env.CF_AI_GATEWAY_ID && env.GEMINI_API_KEY) {
    const url = `wss://gateway.ai.cloudflare.com/v1/${env.CF_AI_GATEWAY_ACCOUNT}/${env.CF_AI_GATEWAY_ID}/google`
      + `?api_key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const headers: Record<string, string> = {};
    if (env.CF_AIG_TOKEN) headers['cf-aig-authorization'] = `Bearer ${env.CF_AIG_TOKEN}`;
    return { url, headers };
  }
  return {
    url: `${WS_HOST}${WS_PATH}?key=${encodeURIComponent(env.GEMINI_API_KEY ?? '')}`,
    headers: {},
  };
}

/** An upgrade request for the Live socket — `fetch()` it and take `response.webSocket`.
 *  Workers' fetch expresses an upgrade as an http(s) request carrying
 *  `Upgrade: websocket`; the wss:// spelling is what browsers and the `direct` mode use. */
export function liveSocketRequest(env: Env, opts: { model: string; token?: string }): Request {
  const { url, headers } = liveSocket(env, opts);
  const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  return new Request(httpUrl, { headers: { ...headers, upgrade: 'websocket' } });
}

/**
 * Live models are *stricter* about thinking than the text models, in opposite
 * directions (verified against the Live API):
 *   · gemini-3.8-live-extended-thinking **requires** generationConfig.thinkingConfig
 *     .thinkingLevel (low | medium | high) — without it the socket closes 1007
 *   · every other Live model **rejects** it — with it the socket closes 1007
 * So the level is a property of the model, not a caller preference, and 'minimal' is
 * never offered (the only model that takes a level rejects it).
 */
export function liveThinkingLevel(model: string, want: ThinkingLevel = 'low'): ThinkingLevel | undefined {
  const bare = model.replace(/^models\//, '');
  if (!/-extended-thinking$/.test(bare)) return undefined;
  return want === 'minimal' ? 'low' : want;
}

/**
 * Live setup message. The settings that matter most for language learners:
 *   · generous VAD silence window — the model must not barge in while a learner is
 *     assembling a sentence. Real learners need 1.5–2.5s of thinking room.
 *   · barge-in enabled — they must be able to talk over the tutor, as with a human.
 *   · input+output transcription — the transcript is the evidence that feeds the
 *     learner model, and it gives the learner a text record to study.
 *
 * Field placement is not free: `model`, `systemInstruction`, `tools`,
 * `realtimeInputConfig`, the transcriptions, `sessionResumption` and
 * `contextWindowCompression` sit at the top of `setup`, while modalities, voice and
 * thinking live inside `generationConfig`.
 */
export function liveSetup(opts: {
  model: string;
  systemInstruction: string;
  voice?: string;
  languageCode?: string;
  tools?: unknown[];
  resumptionHandle?: string;
  silenceMs?: number;
  thinking?: ThinkingLevel;
}) {
  const thinkingLevel = liveThinkingLevel(opts.model, opts.thinking);
  return {
    setup: {
      model: `models/${opts.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode: opts.languageCode ?? 'ja-JP',
          voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice ?? 'Aoede' } },
        },
        // Present only for the models that demand it (see liveThinkingLevel).
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
      },
      systemInstruction: { parts: [{ text: opts.systemInstruction }] },
      // Turn-taking tuned for a learner, not a customer-service bot.
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          silenceDurationMs: opts.silenceMs ?? 1800,   // room to think
          prefixPaddingMs: 300,
          // Both of these are HIGH | LOW only — there is no MEDIUM. `start: LOW`
          // because a learner muttering to themselves or breathing mid-thought should
          // not be treated as the start of a turn; `end: LOW` because 1.8s of silence
          // must pass before we decide they are finished. The cost of LOW start is a
          // quiet learner occasionally being missed; the cost of HIGH was the model
          // barging in, which is worse for a tutor.
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
        },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS', // barge-in allowed
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Declarations carry behavior:NON_BLOCKING for the thinking model, which is the
      // only one that runs tools in the background (see toFunctionDeclarations).
      ...(opts.tools?.length
        ? { tools: [{ functionDeclarations: toFunctionDeclarations(opts.tools, Boolean(thinkingLevel)) }] }
        : {}),
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

/**
 * Short-lived, single-use token so the *browser* can talk to the Live API directly.
 * Lowest latency path, and the long-lived API key never reaches the client.
 * Server-to-server relay through LiveSessionDO is the default (see runtime/live.ts) —
 * we use the relay because it lets the DO handle tool calls and persist the transcript
 * as it streams; this exists for the latency-critical path.
 *
 * Note the response carries the token under `name` (`auth_tokens/…`), the times are
 * camelCase `expireTime` / `newSessionExpireTime`, and a token always connects to
 * **BidiGenerateContentConstrained**. The setup that used to ride along here
 * (`system_instruction`) is no longer part of this call: the client sends its own
 * setup message, which the token accepts as long as it carries no field mask.
 */
/** The token request body: snake_case days are over, and both times are ISO strings.
 *  Split out so the shape is assertable without a key, like the other bodies. */
export function tokenBody(
  opts: { minutes?: number; newSessionMinutes?: number } = {},
  now = Date.now(),
): Record<string, unknown> {
  return {
    uses: 1,
    expireTime: new Date(now + (opts.minutes ?? 30) * 60_000).toISOString(),
    newSessionExpireTime: new Date(now + (opts.newSessionMinutes ?? 2) * 60_000).toISOString(),
  };
}

export async function createEphemeralToken(
  env: Env,
  opts: { minutes?: number; newSessionMinutes?: number },
): Promise<{ token: string; expiresAt: number; transport: string; wsUrl: string }> {
  const { url, transport } = baseUrl(env);
  const now = Date.now();
  const expiresAt = now + (opts.minutes ?? 30) * 60_000;
  const res = await fetch(`${url}/auth_tokens`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify(tokenBody(opts, now)),
  });
  const raw = await res.text();
  if (!res.ok) throw new ModelCallError(describeError(res.status, raw), res.status);
  let body: any;
  try { body = JSON.parse(raw); } catch { throw new ModelCallError(`auth_tokens: unparseable response ${raw.slice(0, 200)}`); }
  const token = body.name ?? body.token;
  if (!token) throw new ModelCallError(`auth_tokens: no token in response ${raw.slice(0, 200)}`);
  return { token, expiresAt, transport, wsUrl: `${WS_HOST}${WS_PATH_CONSTRAINED}?access_token=${encodeURIComponent(token)}` };
}

// ------------------------------------------------------------------ TTS

/**
 * Japanese audio for reading / listening / shadowing.
 *
 * Quality path: Gemini TTS (gemini-3.1-flash-tts-preview) — native Japanese prosody,
 * which matters because we are teaching pitch and mora timing. Speech generation is a
 * media request now: `response_format: {type: 'audio'}` (there is no `response_modalities`
 * field any more) with the voice in `generation_config.speech_config`, which is a list
 * of `{voice}` (or `{speaker, voice}` for two speakers).
 *
 * Fallback path: the browser's own ja-JP speech synthesis (client-side, free, instant)
 * — used when this returns null, and for tap-to-hear individual words, where the latency
 * of a round trip is worse than slightly robotic output.
 *
 * Note: Workers AI has excellent STT (@cf/deepgram/nova-3, @cf/openai/whisper-large-v3-turbo)
 * but its TTS models (Deepgram Aura 1/2) are English/Spanish only — so Japanese audio
 * deliberately does not go through Workers AI.
 */
/** The TTS request body, split out for the same reason as `interactionBody`: this
 *  shape is one of the ones that broke, so it should be assertable without a key. */
export function ttsBody(env: Env, text: string, opts: { voice?: string } = {}): Record<string, unknown> {
  return {
    model: env.MODEL_TTS || 'gemini-3.1-flash-tts-preview',
    input: text,
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: opts.voice ?? 'Aoede' }] },
  };
}

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
    body: JSON.stringify(ttsBody(env, text, opts)),
  });
  if (!res.ok) {
    // The caller falls back to browser speech synthesis, which is a normal outcome —
    // but the reason belongs in the log, not in a silent null.
    console.warn(`tts: ${describeError(res.status, await res.text())}`);
    return null;
  }
  const body: any = await res.json().catch(() => null);
  const audio = extractAudio(body);
  if (!audio) console.warn('tts: response carried no audio block');
  return audio ?? null;
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
