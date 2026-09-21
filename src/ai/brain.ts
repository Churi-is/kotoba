/**
 * brain.ts — one interface, one implementation.
 *
 * Everything the product asks of "the tutor" goes through TutorBrain. There is no
 * scripted fallback any more: if no model key is configured, getBrain() throws
 * ModelConfigError (the API turns that into a 503 with setup instructions), and if
 * the model misbehaves the error surfaces instead of being quietly covered by
 * templates. Callers never get surprised by template output masquerading as judgement.
 */

import type { Beat, Env, Feedback, LearnerModel, Profile, SessionPlan } from '../types';
import {
  MODEL_FOR, callJSON, callModel, hasKey, ModelCallError, ModelOutputError, type ModelResult, liveSetup, LIVE_TOOLS,
  SLOW_CALL_TIMEOUT_MS,
} from './gemini';
import {
  TUTOR_PERSONA, PLAN_SCHEMA, PLACEMENT_SCHEMA, plannerPrompt, feedbackPrompt, FEEDBACK_SCHEMA, DEBRIEF_SCHEMA, turnSystemPrompt, turnUserPrompt,
  placementSynthesisPrompt, glossPrompt, storyPrompt, registerPrompt, debriefPrompt, planRepairPrompt, curriculumDigest,
  type PlanRequest,
} from './prompts';
import { validateBeat } from '../domain/tasks';
import { ERROR_TAXONOMY } from '../domain/pedagogy';
import { evidenceSeedModel } from '../domain/learner-model';

/** What an operator needs to hear when nothing is configured. */
export const AI_SETUP_MESSAGE =
  'Kotoba’s tutor needs a model key: run `wrangler secret put GEMINI_API_KEY` ' +
  '(or route via Cloudflare AI Gateway with vars CF_AI_GATEWAY_ACCOUNT + CF_AI_GATEWAY_ID and `wrangler secret put CF_AIG_TOKEN`), ' +
  'then redeploy. There is no scripted fallback mode.';

export class ModelConfigError extends Error {
  readonly code = 'ai_not_configured' as const;
  constructor(message: string = AI_SETUP_MESSAGE) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

export interface BrainMeta {
  kind: 'gemini';
  model: string;
  transport: string;
  ms: number;
  /** Server-side conversation handle. Pass it back on the next turn and the model
   *  already knows what was said; the API keeps the history, we keep the id. */
  interactionId?: string;
}

export interface TurnResult { text: string; note?: string; meta: BrainMeta }
export interface PlanResult { plan: SessionPlan; meta: BrainMeta }
export interface Debrief {
  headline: string; highlights: string[]; toKeep: Feedback['notices'];
  newCards: { surface: string; reading: string; meaning: string }[]; canDoAdvanced: string;
  nextTeaser: string; notebook: string;
}

export interface TutorBrain {
  readonly kind: 'gemini';

  planSession(req: PlanRequest): Promise<PlanResult>;
  converse(args: {
    plan: SessionPlan; beat: Beat; history: { role: 'tutor' | 'learner'; text: string }[];
    learnerText: string; profile: Profile; model: LearnerModel; interactionId?: string;
  }): Promise<TurnResult>;
  markBeat(args: {
    plan: SessionPlan; beat: Beat; profile: Profile; model: LearnerModel;
    transcript: { role: 'tutor' | 'learner'; text: string }[];
    answers?: { prompt: string; expected: string; given: string; correct: boolean }[];
  }): Promise<{ feedback: Feedback; meta: BrainMeta }>;
  gradeOpen(args: { beat: Beat; text: string; level: string; profile: Profile }): Promise<{ feedback: Feedback; meta: BrainMeta }>;
  debrief(args: {
    plan: SessionPlan; transcript: { role: string; text: string }[]; profile: Profile; model: LearnerModel;
  }): Promise<{ debrief: Debrief; meta: BrainMeta }>;
  synthesizePlacement(args: { profile: Profile; evidence: Record<string, unknown> }): Promise<{ model: LearnerModel; notes: string[]; strengths: string[]; focusAreas: string[]; firstMonthPlan: string[]; caveats: string[]; meta: BrainMeta }>;
  gloss(args: { term: string; context: string; level: string }): Promise<{ reading: string; meaningEN: string; pos: string; note: string; example: string; exampleEN: string; meta: BrainMeta }>;
  story(args: { episode: number; level: string; dueItems: string[]; interests: string[]; previous: string }): Promise<{ titleJA: string; titleEN: string; text: string; glossary: { surface: string; reading: string; meaning: string }[]; hook: string; question: { prompt: string; options: string[]; answer: string; explanation: string }; meta: BrainMeta }>;
  register(args: { content: string; registers: string[] }): Promise<{ items: { register: string; ja: string; reading: string; en: string; note: string }[]; meta: BrainMeta }>;
  /** Mid-session adaptation: has this gone according to plan? */
  adapt(args: {
    plan: SessionPlan; beatIndex: number; profile: Profile; model: LearnerModel;
    recent: { type: string; payload: Record<string, unknown> }[];
  }): Promise<{ action: 'continue' | 'inject' | 'replan' | 'wrap'; reason: string; injectKinds?: string[]; meta: BrainMeta }>;
  simplify(args: { text: string; level: string; knownWords: string[]; allowedNew: number }): Promise<{ text: string; meta: BrainMeta }>;
}

// ------------------------------------------------------------------ gemini brain

class GeminiBrain implements TutorBrain {
  readonly kind = 'gemini' as const;
  constructor(private env: Env) {}

  private m(role: Parameters<typeof MODEL_FOR>[1]) { return MODEL_FOR(this.env, role); }

  async planSession(req: PlanRequest): Promise<PlanResult> {
    const input = plannerPrompt(req) + '\n\n' + curriculumDigest(req.model.overall.cefr);
    // Latency budget, learned the hard way: this call used to run the reasoning model
    // at high thinking with a 32k ceiling, which on a slow day thinks past the 100s
    // gateway/edge timeout and surfaces as `gemini 524` after minutes of spinner. Low
    // thinking on the planner is still strong design judgement, and a complete plan is
    // ~4–8k tokens — 16k of combined budget leaves ample headroom for thoughts on top.
    const res = await callJSON<any>(this.env, {
      model: this.m('planner'), system: TUTOR_PERSONA, input, schema: PLAN_SCHEMA,
      thinking: 'balanced', maxOutputTokens: 16_384, timeoutMs: SLOW_CALL_TIMEOUT_MS,
    });
    let plan = normalizePlan(res.json, req, res.model);
    let designNote = '';

    // Validation gate — repair once, then drop beats that are still invalid.
    // A session with four good beats is honest; a session with an invalid beat is broken.
    const problems = plan.beats.flatMap((b, i) => validateBeat(b).problems.map((p) => `beat ${i + 1} (${b.kind}): ${p}`));
    if (problems.length) {
      const repair = await callJSON<any>(this.env, {
        model: this.m('planner'), system: TUTOR_PERSONA,
        input: planRepairPrompt(JSON.stringify(plan), problems, req), schema: PLAN_SCHEMA,
        thinking: 'balanced', maxOutputTokens: 16_384, timeoutMs: SLOW_CALL_TIMEOUT_MS,
      });
      const repaired = normalizePlan(repair.json, req, repair.model);
      const valid = repaired.beats.filter((b) => validateBeat(b).ok);
      const dropped = repaired.beats.length - valid.length;
      if (!valid.length) {
        throw new ModelOutputError(
          `The planner produced an unusable session plan twice in a row (${problems.length} validation problem(s), first: "${problems[0]}"). Try starting the session again.`,
        );
      }
      plan = { ...repaired, beats: valid, totalMinutes: valid.reduce((a, b) => a + b.minutes, 0) };
      designNote = dropped ? ` (validated, repaired, ${dropped} invalid beat(s) dropped)` : ' (validated, repaired)';
    }
    plan.designedBy = `${res.model}${res.transport === 'gateway' ? ' via AI Gateway' : ''}${designNote}`;
    return { plan, meta: metaOf(res) };
  }

  async converse(a: Parameters<TutorBrain['converse']>[0]): Promise<TurnResult> {
    const turn = {
      model: this.m('tutor'),
      system: turnSystemPrompt(a.profile, a.model, a.beat, a.plan),
      thinking: 'balanced' as const,
      // Generous next to the 1–3 sentences we ask for, because max_output_tokens pays
      // for thoughts *and* answer — a tight ceiling here truncates the tutor mid-word.
      maxOutputTokens: 2048,
    };
    // Server-side state (previous_interaction_id) is an optimisation, never a single
    // point of failure: the interaction may have aged out or the id may belong to a
    // different learner, and a dead tutor mid-lesson is worse than a re-sent history.
    // With a valid id we send only the new line; the model already has the rest.
    let res: ModelResult;
    if (a.interactionId) {
      try {
        res = await callModel(this.env, {
          ...turn,
          input: turnUserPrompt(a.history, a.learnerText, { skipHistory: true }),
          previousInteractionId: a.interactionId,
        });
      } catch (err) {
        if (!(err instanceof ModelCallError)) throw err;
        res = await callModel(this.env, { ...turn, input: turnUserPrompt(a.history, a.learnerText) });
      }
    } else {
      res = await callModel(this.env, { ...turn, input: turnUserPrompt(a.history, a.learnerText) });
    }
    const [main, noteLine] = res.text.split(/\n?NOTE:/);
    return {
      text: (main ?? '').trim() || 'すみません、もう一度 お願いします。',
      note: noteLine?.trim(),
      meta: metaOf(res),
    };
  }

  async markBeat(a: Parameters<TutorBrain['markBeat']>[0]) {
    const res = await callJSON<any>(this.env, {
      model: this.m('tutor'), system: TUTOR_PERSONA,
      input: feedbackPrompt({ ...a, model: a.model ?? a.model, timing: a.profile.style.correctionTiming } as any),
      schema: FEEDBACK_SCHEMA, thinking: 'balanced', maxOutputTokens: 8192,
    });
    return { feedback: normalizeFeedback(res.json, a.beat, a.model?.overall?.cefr ?? 'A2'), meta: metaOf(res) };
  }

  async gradeOpen(a: Parameters<TutorBrain['gradeOpen']>[0]) {
    const res = await callJSON<any>(this.env, {
      model: this.m('tutor'), system: TUTOR_PERSONA,
      input: `Mark this piece of writing against its rubric.\n\nPROMPT: ${a.beat.openEnded?.promptJA}\nRUBRIC: ${JSON.stringify(a.beat.openEnded?.rubric)}\nLEARNER LEVEL: ${a.level}\nLEARNER WROTE:\n${a.text}\n\nMarking rules: judge task achievement first, then range, accuracy, cohesion. Maximum 3 notices, each with an \`elicit\` question in Japanese that would let them self-correct. Quote their own words in wins. Do not correct errors above their level that they could not plausibly know.\n\nReturn JSON matching the feedback schema.`,
      schema: FEEDBACK_SCHEMA, thinking: 'balanced', maxOutputTokens: 8192,
    });
    return { feedback: normalizeFeedback(res.json, a.beat, a.level), meta: metaOf(res) };
  }

  async debrief(a: Parameters<TutorBrain['debrief']>[0]) {
    const res = await callJSON<any>(this.env, {
      model: this.m('tutor'), system: TUTOR_PERSONA,
      input: debriefPrompt(a.plan, a.transcript, a.profile.style.correctionTiming),
      schema: DEBRIEF_SCHEMA,
      thinking: 'balanced', maxOutputTokens: 4096,
    });
    return { debrief: normalizeDebrief(res.json), meta: metaOf(res) };
  }

  async synthesizePlacement(a: Parameters<TutorBrain['synthesizePlacement']>[0]) {
    const res = await callJSON<any>(this.env, {
      model: this.m('planner'), system: TUTOR_PERSONA,
      input: placementSynthesisPrompt({ profile: a.profile, evidence: a.evidence, selfReport: a.profile }),
      // The one call that must never free-form: it runs on the reasoning model over the
      // noisiest input in the app while the learner watches a spinner. Without the schema
      // the pro model writes a tutor's essay, and the parser meets prose, not JSON.
      // Same latency lesson as planSession: low thinking + a 16k ceiling keeps this
      // under the gateway timeout where high thinking + 32k did not.
      schema: PLACEMENT_SCHEMA,
      thinking: 'balanced', maxOutputTokens: 16_384, timeoutMs: SLOW_CALL_TIMEOUT_MS,
    });
    const j = res.json as any;
    return {
      model: normalizeLearnerModel(j, a.profile, a.evidence),
      notes: j?.notes ?? [],
      strengths: j?.strengths ?? [],
      focusAreas: j?.focusAreas ?? [],
      firstMonthPlan: j?.firstMonthPlan ?? [],
      caveats: j?.confidenceCaveats ?? [],
      meta: metaOf(res),
    };
  }

  async gloss(a: Parameters<TutorBrain['gloss']>[0]) {
    const res = await callJSON<any>(this.env, { model: this.m('fast'), input: glossPrompt(a.term, a.context, a.level), thinking: 'bulk', maxOutputTokens: 2048 });
    const j = res.json as any;
    return { reading: j.reading ?? '', meaningEN: j.meaningEN ?? '', pos: j.pos ?? '', note: j.note ?? '', example: j.example ?? '', exampleEN: j.exampleEN ?? '', meta: metaOf(res) };
  }

  async story(a: Parameters<TutorBrain['story']>[0]) {
    const res = await callJSON<any>(this.env, { model: this.m('tutor'), input: storyPrompt(a), thinking: 'balanced', maxOutputTokens: 4096 });
    const j = res.json as any;
    return { titleJA: j.titleJA, titleEN: j.titleEN, text: j.text, glossary: j.glossary ?? [], hook: j.hook ?? '', question: j.question ?? { prompt: '', options: [], answer: '', explanation: '' }, meta: metaOf(res) };
  }

  async register(a: Parameters<TutorBrain['register']>[0]) {
    const res = await callJSON<any>(this.env, { model: this.m('tutor'), input: registerPrompt(a.content, a.registers), thinking: 'balanced', maxOutputTokens: 4096 });
    const j = res.json as any;
    return { items: j.items ?? [], meta: metaOf(res) };
  }

  /** Adaptation is a cheap, high-value call: a small model deciding "carry on / add a
   *  mini-drill / change plan / wrap up" from the last few events. */
  async adapt(a: Parameters<TutorBrain['adapt']>[0]) {
    const res = await callJSON<any>(this.env, {
      model: this.m('fast'), system: TUTOR_PERSONA,
      input: `You are monitoring a live tutoring session and deciding whether to stay the course.
Plan: ${a.plan.titleEN} — beats: ${a.plan.beats.map((b, i) => `${i + 1}.${b.kind}(${b.minutes}m)`).join(', ')}
Currently at beat ${a.beatIndex + 1}: ${a.plan.beats[a.beatIndex]?.titleEN} (objective: ${a.plan.beats[a.beatIndex]?.objective})
Learner is ${a.model.overall.cefr}; recurring errors: ${a.model.errorProfile.slice(0, 4).map((e) => e.tag).join(', ') || 'none'}.
Recent events:
${a.recent.slice(-12).map((e) => `- ${e.type}: ${JSON.stringify(e.payload).slice(0, 160)}`).join('\n')}

Rules:
- "continue" is the right answer most of the time. Only change course on clear evidence.
- "inject" if they are stuck on ONE specific thing that a 2–3 minute drill would fix right now. Suggest at most one: quiz | grammar_focus | shadowing | pronunciation | warmup.
- "replan" if the whole approach is mismatched (too hard, too easy, the learner asked).
- "wrap" if time is short or they are clearly fatigued (short answers, many skips, "too hard" twice).
Answer in JSON: {action, reason (one sentence, no jargon), injectKinds?}`,
      thinking: 'bulk', maxOutputTokens: 2048,
    });
    const j = res.json as any;
    const action = ['continue', 'inject', 'replan', 'wrap'].includes(j?.action) ? j.action : 'continue';
    return { action, reason: j?.reason ?? 'staying the course', injectKinds: j?.injectKinds, meta: metaOf(res) };
  }

  async simplify(a: Parameters<TutorBrain['simplify']>[0]) {
    const res = await callJSON<any>(this.env, {
      model: this.m('fast'),
      input: `Rewrite this Japanese passage so that a ${a.level} learner reading at 96% known-vocabulary coverage can understand it. Keep the same information and roughly the same length. Only these words may be new to them: up to ${a.allowedNew} items. Prefer simpler syntax over shorter text: split complex clauses, use high-frequency connectives, keep naturalness.\n\nPASSAGE:\n${a.text}\n\nTheir known vocabulary sample: ${a.knownWords.slice(0, 60).join('、')}\n\nReturn JSON {text} only.`,
      thinking: 'bulk', maxOutputTokens: 4096,
    });
    return { text: (res.json as any)?.text ?? a.text, meta: metaOf(res) };
  }
}

// ------------------------------------------------------------------ selection

/**
 * The only brain left. There is no offline/mock mode: without a key the constructor
 * path throws, and every API surface turns that into an actionable error instead of
 * quietly running scripted content. (AI_MODE=mock existed when a scripted tutor did;
 * it now throws on purpose so a stale config is caught immediately.)
 */
export function getBrain(env: Env): TutorBrain {
  if ((env.AI_MODE ?? 'auto') === 'mock') {
    throw new ModelConfigError('AI_MODE=mock no longer exists — the scripted tutor was removed. Set AI_MODE=auto and configure a model key.');
  }
  if (!hasKey(env)) throw new ModelConfigError();
  return new GeminiBrain(env);
}

// ------------------------------------------------------------------ normalisation

function metaOf(res: ModelResult): BrainMeta {
  return { kind: 'gemini', model: res.model, transport: res.transport, ms: res.ms, interactionId: res.interactionId };
}

export function normalizePlan(j: any, req: PlanRequest, model: string): SessionPlan {
  const beats: Beat[] = (j?.beats ?? []).map((b: any, i: number) => ({
    id: b.id ?? `b${i + 1}`,
    kind: b.kind,
    minutes: Number(b.minutes) || 3,
    titleJA: b.titleJA ?? '—',
    titleEN: b.titleEN ?? b.kind,
    objective: b.objective ?? '',
    why: b.why ?? '',
    targets: b.targets ?? [],
    success: b.success ?? '',
    difficulty: (Math.max(1, Math.min(5, Number(b.difficulty) || 3)) as 1 | 2 | 3 | 4 | 5),
    scaffolding: b.scaffolding ?? [],
    mode: b.mode ?? (req.mode === 'voice' ? 'voice' : 'text'),
    quiz: b.quiz, reading: b.reading, listening: b.listening, conversation: b.conversation,
    openEnded: b.openEnded, lines: b.lines, kanji: b.kanji, grammarPoint: b.grammarPoint,
    extra: b.extra ?? {},
  }));

  return {
    id: `plan.${Date.now().toString(36)}`,
    createdAt: Date.now(),
    titleJA: j?.titleJA ?? 'レッスン',
    titleEN: j?.titleEN ?? 'Session',
    theme: j?.theme ?? '',
    rationale: j?.rationale ?? '',
    canDo: j?.canDo ?? [],
    recipeId: req.recipeId,
    mode: req.mode,
    totalMinutes: beats.reduce((a, b) => a + b.minutes, 0),
    beats,
    focusErrorTags: j?.focusErrorTags ?? [],
    reviewCardIds: req.dueCards.map((c) => c.id),
    nextSession: j?.nextSession,
    designedBy: model,
  };
}

/** Coerce whatever the model returned into a Feedback we can render and trust. */
export function normalizeFeedback(j: any, beat: Beat, level: string): Feedback {
  const notices = (j?.notices ?? []).slice(0, 3).map((n: any) => ({
    quote: String(n.quote ?? ''), tag: n.tag && ERROR_TAXONOMY[n.tag] ? n.tag : 'vocab.collocation',
    issue: String(n.issue ?? ''), recast: String(n.recast ?? ''),
    elicit: String(n.elicit ?? 'もう一度、言ってみましょうか？'),
    severity: (Math.max(1, Math.min(3, Number(n.severity) || 2)) as 1 | 2 | 3),
  }));
  return {
    achieved: j?.achieved ?? `Objective: ${beat.objective}`,
    band: (j?.band ?? level) as any,
    wins: j?.wins ?? [],
    notices,
    targets: (j?.targets ?? []).slice(0, 4),
    nextTime: j?.nextTime ?? '',
    errorTags: notices.map((n: any) => n.tag),
    modelPatch: j?.metrics ? { metrics: j.metrics } as any : undefined,
  };
}

function normalizeDebrief(j: any): Debrief {
  const highlights = Array.isArray(j?.highlights) ? j.highlights.filter((x: unknown) => typeof x === 'string').slice(0, 4) : [];
  const toKeep = Array.isArray(j?.toKeep) ? j.toKeep.slice(0, 3).map((n: any) => ({
    quote: String(n?.quote ?? ''), tag: String(n?.tag ?? 'vocab.collocation'), issue: String(n?.issue ?? ''), recast: String(n?.recast ?? ''),
    elicit: String(n?.elicit ?? 'どう 言えば いいと 思いますか？'), severity: (Math.max(1, Math.min(3, Number(n?.severity) || 2)) as 1 | 2 | 3),
  })) : [];
  const newCards = Array.isArray(j?.newCards) ? j.newCards.slice(0, 4).map((card: any) => ({
    surface: String(card?.surface ?? ''), reading: String(card?.reading ?? ''), meaning: String(card?.meaning ?? ''),
  })).filter((card: any) => card.surface) : [];
  return {
    headline: String(j?.headline ?? 'Session complete.'),
    highlights,
    toKeep,
    newCards,
    canDoAdvanced: String(j?.canDoAdvanced ?? ''),
    nextTeaser: String(j?.nextTeaser ?? ''),
    notebook: String(j?.notebook ?? ''),
  };
}

/** The model returns a narrative model; we merge it into the numeric learner model
 *  the rest of the system reads. Fields the model did not address keep the values
 *  computed from raw placement evidence (domain/learner-model.ts). */
export function normalizeLearnerModel(j: any, profile: Profile, evidence: Record<string, any>): LearnerModel {
  const base = evidenceSeedModel(profile, evidence);
  if (!j) return base;
  const skills = { ...base.skills } as any;
  for (const [k, v] of Object.entries<any>(j.skills ?? {})) {
    if (!skills[k]) continue;
    skills[k] = {
      cefr: v.cefr ?? skills[k].cefr,
      percentile: Number.isFinite(v.percentile) ? v.percentile : skills[k].percentile,
      confidence: Math.min(0.85, Number(v.confidence) || skills[k].confidence),
      evidenceCount: Number(v.evidenceCount) || skills[k].evidenceCount,
      lastUpdated: Date.now(),
      why: v.why,
    };
  }
  return {
    ...base,
    skills,
    overall: {
      cefr: j.overall?.cefr ?? base.overall.cefr,
      confidence: Math.min(0.85, Number(j.overall?.confidence) || base.overall.confidence),
      jlptEstimate: j.overall?.jlptEstimate ?? base.overall.jlptEstimate,
      jlptScoreBand: j.overall?.jlptScoreBand,
    },
    vocabSizeEstimate: Number(j.vocabSizeEstimate) || base.vocabSizeEstimate,
    kanjiKnown: Number(j.kanjiKnown) || base.kanjiKnown,
    scripts: { ...base.scripts, ...(j.scripts ?? {}) },
    metrics: { ...base.metrics, ...(j.metrics ?? {}) },
    notes: [...(j.notes ?? []), ...base.notes.slice(0, 1)],
  };
}

/** Exposed so the worker can build the same Live setup the browser or DO will use. */
export function liveSessionConfig(env: Env, systemInstruction: string, deep = false, resumptionHandle?: string) {
  return liveSetup({
    model: MODEL_FOR(env, deep ? 'liveDeep' : 'live'),
    systemInstruction,
    tools: LIVE_TOOLS,
    resumptionHandle,
    // The extended-thinking model requires a level; the others reject one outright.
    thinking: deep ? 'high' : 'low',
  });
}
