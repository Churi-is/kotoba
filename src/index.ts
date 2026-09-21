/**
 * Kotoba — Cloudflare Worker entrypoint.
 *
 *   browser (static assets)  ──/api/*──▶  this Worker  ──▶  LearnerDO (state, memory)
 *                                                     └─▶  LiveSessionDO ─▶ Gemini 3.8 Live
 *
 * The Worker itself is stateless glue: auth, validation, prompts, and cost control.
 * All learner memory lives in the Durable Object. Everything the model does goes
 * through a TutorBrain — and when no model can be reached, the answer is an honest,
 * actionable error (503 not configured / 502 model failure), never scripted content.
 */

import { Hono } from 'hono';
import type { Beat, BeatEvent, Env, Profile, SessionPlan, SessionSummary, Target } from './types';
import { getBrain, liveSessionConfig, ModelConfigError, AI_SETUP_MESSAGE, type TutorBrain } from './ai/brain';
import { MODEL_FOR, ModelCallError, ModelOutputError, createEphemeralToken, synthesize, hasKey } from './ai/gemini';
import { TOOLS, TOOL_BY_KIND, validateBeat } from './domain/tasks';
import {
  PLACEMENT_STAGES, buildBank, collectEvidence, emptyProfile, placementEvidenceSummary,
  probesFor, stairNext, stairStart, stairUpdate, stairEstimate, zeroPathStages, kanaScore,
  type StairState, type StageId,
} from './domain/placement';
import {
  CANDO, VOCAB, KANJI, GRAMMAR, SCENARIOS,
} from './content/seed';
import { evidenceSeedModel } from './domain/learner-model';
import { buildQuizBeat, buildGrammarBeat, buildShadowingBeat } from './domain/templates';
import { cefrIndex, pickRecipe, targetLanguageRatio, estimateCoverage, errorTag } from './domain/pedagogy';
import type { LearnerStub, LiveStub } from './runtime/index';

export { LearnerDO } from './runtime/learner';
export { LiveSessionDO } from './runtime/live';

const app = new Hono<{ Bindings: Env; Variables: { learnerId: string } }>();

// ------------------------------------------------------------------ helpers

const encoder = new TextEncoder();

async function sign(env: Env, value: string): Promise<string> {
  const secret = env.SESSION_SECRET || 'dev-secret-change-me';
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, '');
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

/**
 * Device-bound anonymous learner identity: an HMAC-signed cookie, Web Crypto only
 * (per Cloudflare's Worker security guidance). No accounts, no PII, and the learner id
 * is the Durable Object name — so "reset" is literally dropping the cookie.
 *
 * Note: headers are attached *after* next(), because handlers here return raw
 * Response objects and header mutations on the context are not merged into those.
 */
app.use('/api/*', async (c, next) => {
  const cookies = parseCookies(c.req.header('cookie') ?? null);
  let id = '';
  const raw = cookies['kt'];
  if (raw?.includes('.')) {
    const [candidate, sig] = raw.split('.');
    if (sig === (await sign(c.env, candidate))) id = candidate;
  }
  // Belt and braces: clients that cannot hold a cookie — sandboxed iframes with an
  // opaque origin, embedded webviews, "block third-party cookies" — send their
  // device-local id instead. The id is unguessable and carries no PII.
  if (!id) {
    const provided = c.req.header('x-kotoba-learner') ?? c.req.query('learner');
    if (provided && /^L[0-9a-f]{16,32}$/.test(provided)) id = provided;
  }
  let newCookie = '';
  if (!id) {
    id = `L${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    newCookie = `kt=${id}.${await sign(c.env, id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
    // Pre-headers survive into onError responses (which are built with c.json), so an
    // error never costs the learner their identity cookie…
    c.header('set-cookie', newCookie, { append: true });
  }
  c.set('learnerId', id);
  await next();
  // …but most handlers return raw `Response.json(...)` objects, which do not carry
  // pre-headers. Merge the cookie after the fact for those, without doubling it up.
  if (newCookie && !c.res.headers.get('set-cookie')) c.res.headers.append('set-cookie', newCookie);
});

function learner(env: Env, id: string): LearnerStub {
  return env.LEARNER.get(env.LEARNER.idFromName(id)) as unknown as LearnerStub;
}

/** The one way handlers get the tutor. Throws ModelConfigError when no key is
 *  configured — onError below turns that into an actionable 503. */
function brain(c: any): TutorBrain {
  return getBrain(c.env);
}

function bad(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

/**
 * Error taxonomy for the whole API:
 *   503 ai_not_configured  → no model key / AI Gateway; the message says how to fix it
 *   502 ai_call_failed     → the model API itself errored (bad key, outage, quota)
 *   502 ai_output_invalid  → the model answered but produced unusable output twice
 *   500 internal           → everything else
 * The client shows `message` verbatim, so these are written for a person, not a log.
 */
app.onError((err, c) => {
  if (err instanceof ModelConfigError) {
    return c.json({ error: err.code, message: err.message }, 503);
  }
  if (err instanceof ModelCallError || err instanceof ModelOutputError) {
    return c.json({ error: err.code, message: err.message }, 502);
  }
  console.error('unhandled', err);
  return c.json({ error: 'internal', message: (err as Error)?.message ?? 'something broke' }, 500);
});

// ------------------------------------------------------------------ health + config

app.get('/api/health', (c) => Response.json({
  ok: true,
  app: c.env.APP_NAME ?? 'Kotoba',
  aiMode: c.env.AI_MODE ?? 'auto',
  modelKey: hasKey(c.env),
  gateway: Boolean(c.env.CF_AI_GATEWAY_ACCOUNT && c.env.CF_AI_GATEWAY_ID),
  models: {
    planner: MODEL_FOR(c.env, 'planner'),
    tutor: MODEL_FOR(c.env, 'tutor'),
    live: MODEL_FOR(c.env, 'live'),
    tts: MODEL_FOR(c.env, 'tts'),
  },
  tools: TOOLS.length,
}));

app.get('/api/tools', (c) => Response.json({ tools: TOOLS, stages: PLACEMENT_STAGES }));

// ------------------------------------------------------------------ learner

app.get('/api/learner', async (c) => {
  const l = learner(c.env, c.get('learnerId'));
  const [dossier, due] = await Promise.all([l.dossier(), l.dueCards(40)]);
  return Response.json({ ...dossier, due });
});

app.patch('/api/learner', async (c) => {
  const patch = await c.req.json<Partial<Profile>>();
  const l = learner(c.env, c.get('learnerId'));
  const profile = await l.saveProfile(patch);
  return Response.json({ profile });
});

app.post('/api/learner/correct-level', async (c) => {
  // The learner is allowed to overrule the placement. Their judgement is evidence too,
  // so we record it as such and let the first sessions arbitrate.
  const { skill, cefr, note } = await c.req.json<{ skill: string; cefr: any; note?: string }>();
  const l = learner(c.env, c.get('learnerId'));
  const model = await l.getModel();
  if (!model) return bad('no model yet');
  (model.skills as any)[skill] = { ...(model.skills as any)[skill], cefr, confidence: 0.4, lastUpdated: Date.now() };
  await l.saveModel(model);
  await l.addNote(`Learner overruled ${skill} estimate to ${cefr}${note ? `: "${note}"` : ''} — treat as a hypothesis to test in the next two sessions.`);
  return Response.json({ model });
});

// ------------------------------------------------------------------ placement

app.post('/api/placement/start', async (c) => {
  const body = await c.req.json<{ zero?: boolean; name?: string }>().catch(() => ({ zero: false } as any));
  const l = learner(c.env, c.get('learnerId'));
  const profile = body.name ? await l.saveProfile({ name: body.name }) : await l.getProfile();
  const skipped: StageId[] = body.zero ? (['vocabulary', 'grammar', 'reading', 'listening', 'writing', 'interview'] as StageId[]) : [];
  await l.kvPut('placement', { state: 'active', zero: Boolean(body.zero), skipped, responses: {}, started: Date.now() });
  const stages = PLACEMENT_STAGES.filter((s) => !(body.zero && s.naIfZero));
  return Response.json({
    stages: stages.map((s) => ({ ...s, naIfZero: Boolean(s.naIfZero), probes: probesFor(s.id) })),
    profile,
    note: body.zero
      ? 'Starting-from-zero path: we skip the knowledge probes and go straight to speaking, style and your first lesson.'
      : `${stages.length} stages, about 30 minutes. The two staircases run to the end — they are the measurement — but every item has an honest 'I don't know'. The other ${stages.filter((s) => s.skippable).length} can be skipped, and a skip is recorded as lower confidence rather than as a failure.`,
  });
});

app.post('/api/placement/item', async (c) => {
  const { section } = await c.req.json<{ section: 'vocabulary' | 'grammar' }>();
  const l = learner(c.env, c.get('learnerId'));
  const st = (await l.kvGet<any>('placement')) ?? { responses: {} };
  const state: StairState = st.responses?.[section]?.state ?? stairStart();
  const item = stairNext(state, section);
  if (!item) return Response.json({ done: true, estimate: stairEstimate(state) });
  return Response.json({
    item: { ...item, answer: undefined },        // never ship the key to the client
    progress: { served: state.total, level: state.level },
  });
});

/**
 * A hint request is evidence, not a freebie: it says the item was blocked by the
 * writing system rather than by the meaning. Recorded, never scored.
 */
app.post('/api/placement/hint', async (c) => {
  const { section, id } = await c.req.json<{ section: string; id: string }>();
  const l = learner(c.env, c.get('learnerId'));
  const item = buildBank().find((b) => b.id === id);
  await l.logEvent('placement', {
    ts: Date.now(), beatId: section, type: 'hint',
    payload: { itemId: id, hint: item?.hint ?? null, level: item?.level, tags: item?.tags },
  });
  return Response.json({ ok: true });
});

app.post('/api/placement/answer', async (c) => {
  const { section, id, given, unsure } = await c.req
    .json<{ section: 'vocabulary' | 'grammar'; id: string; given?: string; unsure?: boolean }>();
  const l = learner(c.env, c.get('learnerId'));
  const st = (await l.kvGet<any>('placement')) ?? { responses: {} };
  const item = buildBank().find((b) => b.id === id);
  if (!item) return bad('unknown item');
  const dontKnow = Boolean(unsure);
  const correct = !dontKnow && normalize(given ?? '') === normalize(item.answer);
  const prev: StairState = st.responses?.[section]?.state ?? stairStart();
  const next = stairUpdate(prev, item, correct, dontKnow);
  st.responses[section] = { state: next };
  await l.kvPut('placement', st);
  await l.logEvent('placement', {
    ts: Date.now(), beatId: section, type: 'answer',
    payload: { itemId: id, given: dontKnow ? '«unsure»' : given, correct, unsure: dontKnow, expected: item.answer, level: item.level, tags: item.tags },
  });
  const done = next.total >= 14;
  return Response.json({
    correct, unsure: dontKnow, explanation: item.explanation, target: item.answer,
    next: done ? null : { ...(stairNext(next, section) as any), answer: undefined },
    estimate: stairEstimate(next),
    progress: { served: next.total, level: next.level, limit: 14 },
  });
});

app.post('/api/placement/stage', async (c) => {
  const { stage, payload } = await c.req.json<{ stage: StageId; payload: any }>();
  const l = learner(c.env, c.get('learnerId'));
  const st = (await l.kvGet<any>('placement')) ?? { responses: {} };
  st.responses = st.responses ?? {};

  switch (stage) {
    case 'goal': st.responses.goal = payload; break;
    case 'background': st.responses.background = payload; break;
    case 'script': {
      const kana = payload?.kana ?? [];
      st.responses.script = { kana, kanaScore: kana.length ? kanaScore(kana) : null, kanji: payload?.kanji ?? [] };
      break;
    }
    case 'reading': st.responses.reading = payload; break;      // {chars, seconds, correct, total}
    case 'listening': st.responses.listening = payload; break;  // {correct, total, speeds}
    case 'writing': st.responses.writing = payload; break;      // {score, sample, notes}
    case 'style': st.responses.style = payload; break;
    case 'interview': st.responses.interview = payload; break;  // {score, turns, transcript}
    case 'speaking': {
      // Speaking is marked by the model against the probes, not by us.
      const profile = await l.getProfile();
      const fb = await brain(c).markBeat({
        plan: { id: 'placement', titleEN: 'Placement interview', titleJA: '面接', theme: '', rationale: '', canDo: [], recipeId: 'placement', mode: 'voice', totalMinutes: 5, beats: [], focusErrorTags: [], reviewCardIds: [], createdAt: Date.now(), designedBy: '' },
        beat: { id: 'sp', kind: 'roleplay', minutes: 5, titleJA: '話す', titleEN: 'Speaking probe', objective: 'Assess intelligibility, fluency and range', why: '', targets: [], success: '', difficulty: 3, scaffolding: [], mode: 'voice' },
        profile,
        // No learner model exists yet during placement — the marking prompt gets the
        // neutral numeric seed purely as context, never as stored state.
        model: (await l.getModel()) ?? evidenceSeedModel(profile, {}),
        transcript: (payload?.turns ?? []).map((t: any) => ({ role: t.role, text: t.text })),
      });
      st.responses.speaking = {
        meanScore: fb.feedback.notices.length ? 0.55 : 0.72,
        notices: fb.feedback.notices, wins: fb.feedback.wins, transcript: payload?.turns ?? [],
      };
      break;
    }
    case 'reveal': st.state = 'done'; break;
  }
  await l.kvPut('placement', st);
  return Response.json({ ok: true });
});

/** Debug/dev view of the in-flight placement state (the learner's own data). */
app.get('/api/placement/state', async (c) => {
  const l = learner(c.env, c.get('learnerId'));
  const st = await l.kvGet<any>('placement');
  return Response.json(st ?? { state: 'none' });
});

app.post('/api/placement/finish', async (c) => {
  const l = learner(c.env, c.get('learnerId'));
  const st = (await l.kvGet<any>('placement')) ?? { responses: {} };
  const r = st.responses ?? {};

  const profile = await l.saveProfile({
    goals: {
      primary: r.goal?.primary ?? 'fun',
      detail: r.goal?.detail ?? '',
      targetLevel: r.goal?.targetLevel ?? 'A2',
      targetJLPT: r.goal?.targetJLPT ?? 'none',
      deadlineISO: r.goal?.deadlineISO,
      realSituations: r.goal?.realSituations ?? [],
    },
    constraints: {
      minutesPerDay: r.goal?.minutesPerDay ?? 20,
      sessionLength: r.goal?.sessionLength ?? 20,
      daysPerWeek: r.goal?.daysPerWeek ?? 4,
      modePreference: r.goal?.modePreference ?? 'either',
      hasMic: r.goal?.hasMic ?? true,
      device: r.goal?.device ?? 'desktop',
      quietEnvironments: r.goal?.quietEnvironments ?? false,
    },
    style: {
      correctionTiming: r.style?.correctionTiming ?? 'after',
      correctionStyle: r.style?.correctionStyle ?? 'gentle',
      l1Support: r.style?.l1Support ?? 'explanations',
      romaji: r.style?.romaji ?? 'on_demand',
      kanjiAppetite: r.style?.kanjiAppetite ?? 'steady',
      pitchAccentInterest: Boolean(r.style?.pitchAccentInterest),
      interests: r.style?.interests ?? [],
      avoidTopics: r.style?.avoidTopics ?? [],
      painPoints: r.style?.painPoints ?? [],
      motivationNote: r.style?.motivationNote ?? '',
    },
    background: {
      yearsStudying: r.background?.yearsStudying ?? 0,
      formalClasses: Boolean(r.background?.formalClasses),
      inJapanMonths: r.background?.inJapanMonths ?? 0,
      priorTests: r.background?.priorTests ?? [],
      selfRating: r.background?.selfRating ?? {},
    },
  });

  // The adaptive staircases live server-side; merge them back in so the synthesis
  // prompt sees the real trail, not just the client’s summary.
  r.vocabulary = { state: st.responses?.vocabulary?.state };
  r.grammar = { state: st.responses?.grammar?.state };
  r.__skipped = st.skipped ?? [];
  const evidence = collectEvidence(r);
  const synth = await brain(c).synthesizePlacement({ profile, evidence });
  await l.saveModel(synth.model);
  for (const n of synth.notes ?? []) await l.addNote(n);
  await l.seedCanDo(CANDO.map((c2) => ({ id: c2.id, level: c2.level, skill: c2.skill, statement: c2.statement })));

  const caveats = [
    ...(synth.caveats ?? []),
    ...placementEvidenceSummary(evidence, st.skipped ?? []),
  ];

  await l.kvPut('placement', { ...st, state: 'done', evidence });

  return Response.json({
    model: synth.model,
    evidence,
    strengths: synth.strengths,
    focusAreas: synth.focusAreas,
    firstMonthPlan: synth.firstMonthPlan,
    caveats,
    meta: synth.meta,
    recommendedRecipe: pickRecipe(synth.model, profile.constraints.sessionLength).id,
    readingSupport: {
      targetRatio: targetLanguageRatio(synth.model.skills.speaking.cefr, profile.style.l1Support),
      maxNewTokensPerPassage: cefrIndex(synth.model.overall.cefr) < 3 ? 2 : 4,
    },
  });
});

// ------------------------------------------------------------------ sessions

app.post('/api/session/start', async (c) => {
  const body = await c.req.json<{ minutes?: number; mode?: 'voice' | 'text'; goalHint?: string; energy?: string }>().catch(() => ({} as any));
  const l = learner(c.env, c.get('learnerId'));
  const ctx = await l.planContext();
  if (!ctx.model) return bad('placement not finished yet', 409);

  const profile = ctx.profile;
  const minutes = body.minutes ?? profile.constraints.sessionLength;
  const mode = body.mode ?? (profile.constraints.modePreference === 'either' ? 'text' : profile.constraints.modePreference);
  const deadlineDays = profile.goals.deadlineISO
    ? Math.max(0, Math.round((new Date(profile.goals.deadlineISO).getTime() - Date.now()) / 86_400_000))
    : undefined;
  const recipe = pickRecipe(ctx.model, minutes, body.goalHint as any, deadlineDays);

  const tutor = brain(c);
  const reqObj = {
    profile, model: ctx.model, recipeId: recipe.id, recipeShape: recipe.shape as any,
    minutes, mode: mode as 'voice' | 'text', goalHint: body.goalHint,
    dueCards: ctx.dueCards.map((d) => ({ id: d.id, surface: d.surface, reading: d.reading, meaning: d.meaning, kind: d.kind, state: d.state })),
    recentNotices: ctx.recentNotices, sessionNumber: ctx.sessionNumber, lastSummary: ctx.lastSummary,
  };

  const { plan, meta } = await tutor.planSession(reqObj);

  // Comprehensible-input gate: generated passages must sit in the 95–98% band.
  // Simplifications run concurrently — sequential model calls here would stack latency
  // on top of an already slow planner call, pushing the whole request toward the timeout.
  const knownSet = new Set((await l.dueCards(200)).map((d) => d.surface));
  const knownSample = [...knownSet].slice(0, 80);
  // Alias for the closure below: narrowing on ctx.model does not survive into callbacks.
  const currentModel = ctx.model;
  const simplifyTarget = cefrIndex(currentModel.overall.cefr) < 3 ? 0.95 : 0.96;
  await Promise.all(plan.beats.map(async (b) => {
    if (!b.reading?.text) return;
    const cov = estimateCoverage(b.reading.text, (t) => knownSet.has(t) || t.length <= 1);
    if (cov.coverage >= simplifyTarget - 0.06) return;
    const sim = await tutor.simplify({
      text: b.reading.text, level: currentModel.overall.cefr,
      knownWords: knownSample, allowedNew: 3,
    });
    b.reading.text = sim.text;
    b.why += ` (Simplified to sit inside 95–98% known vocabulary — the original was too dense to be comfortable input.)`;
  }));

  const cardInfo = await l.addCards(plan.beats.flatMap((b) => b.targets).slice(0, 12), ctx.model.overall.cefr);
  await l.startSession(plan, mode);
  await l.kvPut(`session:${plan.id}`, { plan, events: [], started: Date.now(), mode });

  return Response.json({ plan, meta, recipe: recipe.id, newCards: cardInfo });
});

app.get('/api/session/:id', async (c) => {
  const l = learner(c.env, c.get('learnerId'));
  const s = await l.kvGet<any>(`session:${c.req.param('id')}`);
  if (!s) return bad('unknown session', 404);
  return Response.json(s);
});

app.post('/api/session/:id/event', async (c) => {
  const id = c.req.param('id');
  const e = await c.req.json<BeatEvent>();
  const l = learner(c.env, c.get('learnerId'));
  const s = await l.kvGet<any>(`session:${id}`);
  if (!s) return bad('unknown session', 404);

  await l.logEvent(id, e);
  s.events = [...(s.events ?? []), e];

  // Mid-session adaptation, checked sparingly: at beat boundaries or on a clear signal.
  const beat = s.plan.beats.find((b: Beat) => b.id === e.beatId);
  const signal = (e.type === 'rating' && ['too_hard', 'too_easy', 'lost', 'boring'].includes(String(e.payload.value)))
    || (e.type === 'beat_complete')
    || (e.type === 'skip');
  let adaptation: { action: string; reason: string; beat?: Beat } | null = null;
  let adaptationError: string | undefined;

  if (signal) {
    const model = await l.getModel();
    // The event above is already logged — an adaptation failure must report itself
    // without taking the learner's evidence down with it.
    let decision: any = null;
    try {
      decision = await brain(c).adapt({
        plan: s.plan, beatIndex: Math.max(0, s.plan.beats.findIndex((b: Beat) => b.id === e.beatId)),
        profile: await l.getProfile(), model: model as any,
        recent: (s.events ?? []).slice(-14).map((x: any) => ({ type: x.type, payload: x.payload })),
      });
    } catch (err) {
      adaptationError = (err as Error).message;
    }
    if (!decision) {
      // reported to the client as adaptationError; the session simply stays on plan
    } else if (decision.action === 'inject') {
      // The app supplies the drill; the model decided it was needed. Injected beats are
      // built from validated templates so a live lesson can never break.
      const tag = (model?.errorProfile ?? []).find((x) => !x.resolved)?.tag ?? 'particle.wa_ga';
      const kind = decision.injectKinds?.[0] ?? 'quiz';
      const injected: Beat = kind === 'grammar_focus'
        ? buildGrammarBeat(model?.overall.cefr ?? 'A2', 3, tag)
        : kind === 'shadowing' || kind === 'pronunciation'
          ? buildShadowingBeat(model?.overall.cefr ?? 'A2', 3)
          : buildQuizBeat(model?.overall.cefr ?? 'A2', 3);
      injected.why = `${decision.reason} — 3-minute drill on ${errorTag(tag).label}.`;
      injected.kind = 'quiz';
      const at = s.plan.beats.findIndex((b: Beat) => b.id === e.beatId);
      s.plan.beats.splice(at + 1, 0, injected);
      s.plan.totalMinutes += injected.minutes;
      adaptation = { action: 'inject', reason: decision.reason, beat: injected };
    } else if (decision.action === 'wrap') {
      adaptation = { action: 'wrap', reason: decision.reason };
    } else if (decision.action === 'replan') {
      adaptation = { action: 'replan', reason: decision.reason };
    } else {
      adaptation = { action: 'continue', reason: decision.reason };
    }
  }
  await l.kvPut(`session:${id}`, s);
  return Response.json({ ok: true, adaptation, ...(adaptationError ? { adaptationError } : {}) });
});

app.post('/api/session/:id/turn', async (c) => {
  const id = c.req.param('id');
  const { beatId, text, interactionId } = await c.req.json<{ beatId: string; text: string; interactionId?: string }>();
  const l = learner(c.env, c.get('learnerId'));
  const s = await l.kvGet<any>(`session:${id}`);
  if (!s) return bad('unknown session', 404);
  const beat = s.plan.beats.find((b: Beat) => b.id === beatId);
  if (!beat) return bad('unknown beat', 404);

  const history = (s.events ?? [])
    .filter((e: any) => e.beatId === beatId && (e.type === 'utterance' || e.type === 'tutor_line'))
    .map((e: any) => ({ role: e.type === 'utterance' ? 'learner' : 'tutor', text: String(e.payload.text ?? '') }));

  const model = await l.getModel();
  const turn = await brain(c).converse({
    plan: s.plan, beat, history, learnerText: text,
    profile: await l.getProfile(), model: model as any, interactionId,
  });

  await l.logEvent(id, { ts: Date.now(), beatId, type: 'utterance', payload: { text } });
  await l.logEvent(id, { ts: Date.now(), beatId, type: 'tutor_line', payload: { text: turn.text } });
  s.events = [...(s.events ?? []),
    { ts: Date.now(), beatId, type: 'utterance', payload: { text } },
    { ts: Date.now(), beatId, type: 'tutor_line', payload: { text: turn.text } }];
  if (turn.note) await l.addNote(turn.note, id);
  await l.kvPut(`session:${id}`, s);

  return Response.json({ reply: turn.text, meta: turn.meta, interactionId: turn.meta.interactionId });
});

app.post('/api/session/:id/beat/:beatId/mark', async (c) => {
  const id = c.req.param('id');
  const beatId = c.req.param('beatId');
  const body = await c.req.json<{ answers?: { prompt: string; expected: string; given: string; correct: boolean }[]; text?: string }>().catch(() => ({} as any));
  const l = learner(c.env, c.get('learnerId'));
  const s = await l.kvGet<any>(`session:${id}`);
  if (!s) return bad('unknown session', 404);
  const beat: Beat = s.plan.beats.find((b: Beat) => b.id === beatId);
  if (!beat) return bad('unknown beat', 404);

  const transcript = (s.events ?? [])
    .filter((e: any) => e.beatId === beatId && (e.type === 'utterance' || e.type === 'tutor_line'))
    .map((e: any) => ({ role: e.type === 'utterance' ? 'learner' : 'tutor', text: String(e.payload.text ?? '') }));

  const profile = await l.getProfile();
  const model = await l.getModel();

  const { feedback } = beat.kind === 'open_ended' && body.text
    ? await brain(c).gradeOpen({ beat, text: body.text, level: model?.overall.cefr ?? 'A2', profile })
    : await brain(c).markBeat({ plan: s.plan, beat, profile, model: model as any, transcript, answers: body.answers });

  await l.applyFeedback(feedback, id, beatId);
  await l.logEvent(id, { ts: Date.now(), beatId, type: 'rating', payload: { value: 'marked', notices: feedback.notices.length } });
  return Response.json({ feedback });
});

app.post('/api/session/:id/finish', async (c) => {
  const id = c.req.param('id');
  const l = learner(c.env, c.get('learnerId'));
  const s = await l.kvGet<any>(`session:${id}`);
  if (!s) return bad('unknown session', 404);

  const stats = (s.events ?? []).reduce((a: any, e: any) => {
    if (e.type === 'answer') { a.answered++; if (e.payload.correct) a.correct++; }
    if (e.type === 'utterance') a.spokenTurns++;
    if (e.type === 'hint') a.hintUses++;
    if (e.type === 'skip') a.skipped++;
    return a;
  }, { answered: 0, correct: 0, spokenTurns: 0, writtenTurns: 0, hintUses: 0, skipped: 0 });

  const transcript = (s.events ?? []).map((e: any) => ({ role: e.type === 'utterance' ? 'learner' : 'tutor', text: String(e.payload?.text ?? '') })).filter((t: any) => t.text);
  const { debrief } = await brain(c).debrief({ plan: s.plan, transcript, profile: await l.getProfile(), model: (await l.getModel()) as any });

  for (const c2 of debrief.newCards ?? []) {
    await l.addCards([{ kind: 'vocab', surface: c2.surface, reading: c2.reading, meaning: c2.meaning }], 'session');
  }
  for (const n of debrief.toKeep ?? []) await l.logError(n.tag, n.quote, n.recast, '', id, n.severity);
  if (debrief.notebook) await l.addNote(debrief.notebook, id);

  const summary: SessionSummary = {
    id, planId: s.plan.id, startedAt: s.started ?? Date.now(), endedAt: Date.now(),
    minutes: Math.max(1, Math.round((Date.now() - (s.started ?? Date.now())) / 60000)),
    beatsCompleted: (s.events ?? []).filter((e: any) => e.type === 'beat_complete').length,
    stats, feedback: { achieved: debrief.headline, band: 'A2' as any, wins: debrief.highlights, notices: debrief.toKeep, targets: [], nextTime: debrief.nextTeaser },
    canDoAdvanced: debrief.canDoAdvanced ? [debrief.canDoAdvanced] : [],
    nextTeaser: debrief.nextTeaser,
  };
  await l.finishSession(summary);
  await l.kvDel(`session:${id}`);
  return Response.json({ debrief, summary });
});

// ------------------------------------------------------------------ review (SRS)

app.get('/api/review/due', async (c) => {
  const l = learner(c.env, c.get('learnerId'));
  return Response.json({ due: await l.dueCards(40), stats: await l.deckStats() });
});

app.post('/api/review/grade', async (c) => {
  const { id, grade } = await c.req.json<{ id: string; grade: 1 | 2 | 3 | 4 }>();
  const l = learner(c.env, c.get('learnerId'));
  const card = await l.gradeCard(id, grade);
  return Response.json({ card });
});

// ------------------------------------------------------------------ tools

app.post('/api/tools/gloss', async (c) => {
  const { term, context } = await c.req.json<{ term: string; context?: string }>();
  const l = learner(c.env, c.get('learnerId'));
  const model = await l.getModel();
  const cacheKey = `gloss:${term}`;
  const cached = await l.kvGet<any>(cacheKey);
  if (cached) return Response.json({ ...cached, cached: true });
  const g = await brain(c).gloss({ term, context: context ?? '', level: model?.overall.cefr ?? 'A2' });
  await l.kvPut(cacheKey, g);
  return Response.json(g);
});

app.post('/api/tools/tts', async (c) => {
  const { text, speed } = await c.req.json<{ text: string; speed?: number }>();
  // Quality path: Gemini TTS. If unavailable the client falls back to its own
  // ja-JP speech synthesis, so this endpoint returning null is a normal outcome.
  const audio = await synthesize(c.env, text.slice(0, 900), { speed });
  return Response.json(audio ?? { fallback: 'browser' });
});

app.post('/api/tools/story', async (c) => {
  const { episode, previous } = await c.req.json<{ episode?: number; previous?: string }>().catch(() => ({} as any));
  const l = learner(c.env, c.get('learnerId'));
  const ctx = await l.planContext();
  const s = await brain(c).story({
    episode: episode ?? ((await l.kvGet<number>('storyEpisode')) ?? 0) + 1,
    level: ctx.model?.overall.cefr ?? 'A2',
    dueItems: ctx.dueCards.slice(0, 8).map((d) => d.surface),
    interests: ctx.profile.style.interests,
    previous: previous ?? '',
  });
  await l.kvPut('storyEpisode', episode ?? ((await l.kvGet<number>('storyEpisode')) ?? 0) + 1);
  return Response.json({ story: s });
});

app.post('/api/tools/register', async (c) => {
  const { content, registers } = await c.req.json<{ content: string; registers?: string[] }>();
  const l = learner(c.env, c.get('learnerId'));
  const ctx = await l.planContext();
  const r = await brain(c).register({
    content,
    registers: registers ?? (cefrIndex(ctx.model?.overall.cefr ?? 'A2') < 4 ? ['casual', 'polite'] : ['casual', 'polite', 'honorific', 'humble']),
  });
  return Response.json(r);
});

/** Ask the tutor a meta question — it answers from the learner model, not in general. */
app.post('/api/tutor/ask', async (c) => {
  const { question } = await c.req.json<{ question: string }>();
  const l = learner(c.env, c.get('learnerId'));
  const d = await l.dossier();
  if (!d.model) return bad('no learner model yet', 409);

  const topErrors = d.errors.slice(0, 5).map((e) => `${errorTag(e.tag).label} ×${e.count}`).join(', ');
  const answer = await brain(c).converse({
    plan: { id: 'ask', titleEN: 'Tutor Q&A', titleJA: '質問', theme: '', rationale: '', canDo: [], recipeId: 'ask', mode: 'text', totalMinutes: 2, beats: [], focusErrorTags: [], reviewCardIds: [], createdAt: Date.now(), designedBy: '' },
    beat: {
      id: 'ask', kind: 'free_talk', minutes: 2, titleJA: '質問', titleEN: 'About your learning',
      objective: 'Answer the learner’s meta-question from their own data',
      why: '', targets: [], success: '', difficulty: 1, scaffolding: [], mode: 'text',
      conversation: {
        setting: 'Meta conversation about their learning', tutorRole: 'tutor', learnerRole: 'learner',
        learnerGoal: question, openingLine: '', openingTranslation: '', constraints: ['Answer in English, from their data, not in general'], hints: [], targetIds: [], maxTurns: 3,
      },
    },
    history: [],
    learnerText: `[META QUESTION — answer in English, from their data, not in general. Their level: ${d.model.overall.cefr}. Recurring errors: ${topErrors || 'none logged'}. Deck: ${d.deck.total} cards, ${d.deck.mature} mature. Sessions so far: ${d.model.streaks.totalSessions}, ${d.model.streaks.totalMinutes} minutes. Their goals: ${d.profile.goals.detail}. Recent tutor notes: ${(d.model.notes ?? []).slice(-4).join(' | ')}]${question}`,
    profile: d.profile, model: d.model,
  });
  return Response.json({ answer: answer.text, meta: answer.meta });
});

// ------------------------------------------------------------------ voice (Live API)

app.post('/api/live/start', async (c) => {
  const { sessionId, beatId, deep } = await c.req.json<{ sessionId?: string; beatId?: string; deep?: boolean }>();
  // Voice runs on the Live API only; without a key there is no voice session at all.
  if (!hasKey(c.env)) throw new ModelConfigError('Voice mode needs a model key. ' + AI_SETUP_MESSAGE);
  const l = learner(c.env, c.get('learnerId'));
  const ctx = await l.planContext();
  const s = sessionId ? await l.kvGet<any>(`session:${sessionId}`) : null;
  const beat: Beat | undefined = s?.plan.beats.find((b: Beat) => b.id === beatId) ?? s?.plan.beats[0];

  const ratio = targetLanguageRatio(ctx.model?.skills.speaking.cefr ?? 'A2', ctx.profile.style.l1Support);
  const systemInstruction = [
    `You are Aoi (葵), a private Japanese tutor speaking with your learner by voice.`,
    `Learner: ${ctx.profile.name ?? 'the learner'}, L1 ${ctx.profile.l1}, goal: ${ctx.profile.goals.detail || ctx.profile.goals.primary}, level ${ctx.model?.overall.cefr}.`,
    beat ? `Current activity: ${beat.titleEN} — ${beat.objective}. Success looks like: ${beat.success}.` : `Placement interview: find their real speaking level.`,
    beat?.conversation ? `Scenario: ${beat.conversation.setting}. You are ${beat.conversation.tutorRole}; they are ${beat.conversation.learnerRole}. Their goal: ${beat.conversation.learnerGoal}. Opening line: ${beat.conversation.openingLine}` : '',
    `Speak Japanese about ${Math.round(ratio * 100)}% of the time. Speak slowly and clearly; this is a learner, not a native speaker.`,
    `Corrections: ${ctx.profile.style.correctionTiming} / ${ctx.profile.style.correctionStyle}. Never stack more than one correction per turn; never lecture about grammar.`,
    `Target errors worth watching: ${(ctx.model?.errorProfile ?? []).slice(0, 4).map((e) => e.tag).join(', ') || 'none logged yet'}.`,
    `Call log_error silently when they make a real error; call add_to_review when something is worth keeping. Do not mention the tools.`,
    `Give them time to think — silences of 2–3 seconds are normal for a learner. Never fill every gap.`,
    `Ask about their actual life. Be a person, not an exercise.`,
  ].filter(Boolean).join('\n');

  const live = c.env.LIVE.get(c.env.LIVE.idFromName(`${c.get('learnerId')}:${sessionId ?? 'placement'}`)) as unknown as LiveStub;
  await live.setMeta({
    learnerId: c.get('learnerId'), sessionId: sessionId ?? 'placement', beatId: beat?.id ?? '',
    model: MODEL_FOR(c.env, deep ? 'liveDeep' : 'live'), systemInstruction, deep: Boolean(deep),
  });

  // Two ways to talk to the model. `relay` keeps the transcript + tool calls server-side
  // (default). `direct` hands the browser an ephemeral token for the lowest latency.
  const wantDirect = c.req.query('direct') === '1';
  let direct: any = null;
  if (wantDirect) {
    try {
      // The token itself is bound to no setup; whoever holds it sends its own setup
      // message over the *Constrained* endpoint (see gemini.createEphemeralToken).
      direct = await createEphemeralToken(c.env, { minutes: 30 });
    } catch { direct = null; }
  }

  return Response.json({
    mode: direct ? 'direct' : 'relay',
    wsPath: `/api/live/${encodeURIComponent(sessionId ?? 'placement')}/ws`,
    model: MODEL_FOR(c.env, deep ? 'liveDeep' : 'live'),
    direct,
    systemInstruction,
    config: { ratio, silenceMs: 1800, bargeIn: true },
  });
});

app.get('/api/live/:sessionId/ws', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return bad('expected websocket', 426);
  const id = `${c.get('learnerId')}:${c.req.param('sessionId')}`;
  const stub = c.env.LIVE.get(c.env.LIVE.idFromName(id)) as unknown as LiveStub;
  return stub.fetch(c.req.raw);
});

app.post('/api/live/:sessionId/collect', async (c) => {
  const id = `${c.get('learnerId')}:${c.req.param('sessionId')}`;
  const stub = c.env.LIVE.get(c.env.LIVE.idFromName(id)) as unknown as LiveStub;
  const data = await stub.collect();
  const l = learner(c.env, c.get('learnerId'));
  await l.logLive(c.req.param('sessionId'), 'collect', data.stats ?? {});
  // The transcript is the evidence: run it through the same marking path as text sessions.
  return Response.json(data);
});

// ------------------------------------------------------------------ progress + previews

app.get('/api/progress', async (c) => {
  const l = learner(c.env, c.get('learnerId'));
  return Response.json(await l.progress());
});

app.get('/api/preview/tomorrow', async (c) => {
  // What the tutor is *planning* to do next — the learner's window into the AI's reasoning.
  const l = learner(c.env, c.get('learnerId'));
  const ctx = await l.planContext();
  if (!ctx.model) return bad('no model yet', 409);
  const deadlineDays = ctx.profile.goals.deadlineISO
    ? Math.round((new Date(ctx.profile.goals.deadlineISO).getTime() - Date.now()) / 86_400_000) : undefined;
  const recipe = pickRecipe(ctx.model, ctx.profile.constraints.sessionLength, undefined, deadlineDays);
  return Response.json({
    recipe: recipe.id,
    why: recipe.when,
    shape: recipe.shape,
    focusErrors: ctx.model.errorProfile.filter((e) => !e.resolved).slice(0, 3).map((e) => ({ tag: e.tag, ...errorTag(e.tag), count: e.count })),
    dueCount: ctx.dueCount,
    notes: (ctx.model.notes ?? []).slice(-3),
  });
});

app.get('/api/curriculum', (c) => Response.json({
  vocab: VOCAB.length, grammar: GRAMMAR.length, kanji: KANJI.length, scenarios: SCENARIOS.length,
  branches: ['survival_60', 'jlpt_sprint', 'workplace_keigo', 'media_immersion', 'kanji_catchup', 'pitch_accent'],
  levels: ['pre-A1', 'A1', 'A1+', 'A2.1', 'A2', 'A2+', 'B1', 'B1+', 'B2', 'C1'],
}));

app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

function normalize(s: string) {
  return (s ?? '').trim().toLowerCase().replace(/[。、！？\s「」]/g, '');
}

export default app;
