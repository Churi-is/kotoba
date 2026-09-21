/**
 * brain.ts — one interface, two implementations.
 *
 * Everything the product asks of "the tutor" goes through TutorBrain. That means:
 *  · we can swap models without touching the session engine
 *  · the scripted tutor is a first-class citizen (tests, offline dev, outage fallback)
 *  · every call site has one obvious place to add logging, caching or cost caps
 */

import type { Beat, Env, Feedback, LearnerModel, Profile, SessionPlan, Target } from '../types';
import {
  MODEL_FOR, callJSON, callModel, hasKey, type ModelResult, liveSetup, LIVE_TOOLS,
} from './gemini';
import {
  TUTOR_PERSONA, PLAN_SCHEMA, plannerPrompt, feedbackPrompt, FEEDBACK_SCHEMA, turnSystemPrompt, turnUserPrompt,
  placementSynthesisPrompt, glossPrompt, storyPrompt, registerPrompt, debriefPrompt, planRepairPrompt, curriculumDigest,
  type PlanRequest,
} from './prompts';
import * as mock from './mock';
import { validateBeat } from '../domain/tasks';
import { ERROR_TAXONOMY } from '../domain/pedagogy';

export interface BrainMeta {
  kind: 'gemini' | 'mock';
  model: string;
  transport: string;
  ms: number;
  degraded?: boolean;
  note?: string;
}

export interface TurnResult { text: string; note?: string; meta: BrainMeta }
export interface PlanResult { plan: SessionPlan; meta: BrainMeta }
export interface Debrief {
  headline: string; highlights: string[]; toKeep: Feedback['notices'];
  newCards: { surface: string; reading: string; meaning: string }[]; canDoAdvanced: string;
  nextTeaser: string; notebook: string;
}

export interface TutorBrain {
  readonly kind: 'gemini' | 'mock';

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
    let res = await callJSON<any>(this.env, {
      model: this.m('planner'), system: TUTOR_PERSONA, input, schema: PLAN_SCHEMA, temperature: 0.85,
    });
    let plan = normalizePlan(res.json, req, res.model);

    // Validation gate — repair once, then fall back beat-by-beat.
    const problems = plan.beats.flatMap((b, i) => validateBeat(b).problems.map((p) => `beat ${i + 1} (${b.kind}): ${p}`));
    if (problems.length) {
      const repair = await callJSON<any>(this.env, {
        model: this.m('planner'), system: TUTOR_PERSONA,
        input: planRepairPrompt(JSON.stringify(plan), problems, req), schema: PLAN_SCHEMA, temperature: 0.3,
      });
      if (repair.json) {
        const repaired = normalizePlan(repair.json, req, repair.model);
        const stillBad = repaired.beats.some((b) => !validateBeat(b).ok);
        if (!stillBad) plan = repaired;
        else {
          // Keep the good beats, substitute scripted ones for the broken ones.
          const fallback = mock.mockPlan(req);
          plan = {
            ...repaired,
            beats: repaired.beats.map((b, i) => (validateBeat(b).ok ? b : fallback.beats[i % fallback.beats.length])),
          };
        }
      }
      plan.designedBy += ' (validated, repaired)';
    }
    res = { ...res, model: res.model };
    plan.designedBy = `${res.model}${res.transport === 'gateway' ? ' via AI Gateway' : ''}`;
    return { plan, meta: metaOf(res, 'gemini') };
  }

  async converse(a: Parameters<TutorBrain['converse']>[0]): Promise<TurnResult> {
    const res = await callModel(this.env, {
      model: this.m('tutor'),
      system: turnSystemPrompt(a.profile, a.model, a.beat, a.plan),
      input: turnUserPrompt(a.history, a.learnerText),
      previousInteractionId: a.interactionId,
      temperature: 0.9,
      maxOutputTokens: 400,
    });
    const [main, noteLine] = res.text.split(/\n?NOTE:/);
    return {
      text: (main ?? '').trim() || 'すみません、もう一度 お願いします。',
      note: noteLine?.trim(),
      meta: metaOf(res, 'gemini'),
    };
  }

  async markBeat(a: Parameters<TutorBrain['markBeat']>[0]) {
    const res = await callJSON<any>(this.env, {
      model: this.m('tutor'), system: TUTOR_PERSONA,
      input: feedbackPrompt({ ...a, model: a.model ?? a.model, timing: a.profile.style.correctionTiming } as any),
      schema: FEEDBACK_SCHEMA, temperature: 0.4,
    });
    const fb = (res.json ?? {}) as any;
    return { feedback: normalizeFeedback(fb, a.beat, a.model?.overall?.cefr ?? 'A2'), meta: metaOf(res, 'gemini') };
  }

  async gradeOpen(a: Parameters<TutorBrain['gradeOpen']>[0]) {
    const res = await callJSON<any>(this.env, {
      model: this.m('tutor'), system: TUTOR_PERSONA,
      input: `Mark this piece of writing against its rubric.\n\nPROMPT: ${a.beat.openEnded?.promptJA}\nRUBRIC: ${JSON.stringify(a.beat.openEnded?.rubric)}\nLEARNER LEVEL: ${a.level}\nLEARNER WROTE:\n${a.text}\n\nMarking rules: judge task achievement first, then range, accuracy, cohesion. Maximum 3 notices, each with an \`elicit\` question in Japanese that would let them self-correct. Quote their own words in wins. Do not correct errors above their level that they could not plausibly know.\n\nReturn JSON matching the feedback schema.`,
      schema: FEEDBACK_SCHEMA, temperature: 0.3,
    });
    return { feedback: normalizeFeedback(res.json as any, a.beat, a.level), meta: metaOf(res, 'gemini') };
  }

  async debrief(a: Parameters<TutorBrain['debrief']>[0]) {
    const res = await callJSON<any>(this.env, {
      model: this.m('tutor'), system: TUTOR_PERSONA,
      input: debriefPrompt(a.plan, a.transcript, a.profile.style.correctionTiming),
      temperature: 0.6,
    });
    return { debrief: normalizeDebrief(res.json), meta: metaOf(res, 'gemini') };
  }

  async synthesizePlacement(a: Parameters<TutorBrain['synthesizePlacement']>[0]) {
    const res = await callJSON<any>(this.env, {
      model: this.m('planner'), system: TUTOR_PERSONA,
      input: placementSynthesisPrompt({ profile: a.profile, evidence: a.evidence, selfReport: a.profile }),
      temperature: 0.3,
    });
    const j = res.json as any;
    return {
      model: normalizeLearnerModel(j, a.profile, a.evidence),
      notes: j?.notes ?? [],
      strengths: j?.strengths ?? [],
      focusAreas: j?.focusAreas ?? [],
      firstMonthPlan: j?.firstMonthPlan ?? [],
      caveats: j?.confidenceCaveats ?? [],
      meta: metaOf(res, 'gemini'),
    };
  }

  async gloss(a: Parameters<TutorBrain['gloss']>[0]) {
    const res = await callJSON<any>(this.env, { model: this.m('fast'), input: glossPrompt(a.term, a.context, a.level), temperature: 0.2 });
    const j = res.json ?? mock.mockGloss(a.term, a.level);
    return { reading: j.reading ?? '', meaningEN: j.meaningEN ?? '', pos: j.pos ?? '', note: j.note ?? '', example: j.example ?? '', exampleEN: j.exampleEN ?? '', meta: metaOf(res, 'gemini') };
  }

  async story(a: Parameters<TutorBrain['story']>[0]) {
    const res = await callJSON<any>(this.env, { model: this.m('tutor'), input: storyPrompt(a), temperature: 0.95 });
    const j = res.json ?? mock.mockStory(a.episode, a.level, a.dueItems);
    return { titleJA: j.titleJA, titleEN: j.titleEN, text: j.text, glossary: j.glossary ?? [], hook: j.hook ?? '', question: j.question ?? { prompt: '', options: [], answer: '', explanation: '' }, meta: metaOf(res, 'gemini') };
  }

  async register(a: Parameters<TutorBrain['register']>[0]) {
    const res = await callJSON<any>(this.env, { model: this.m('tutor'), input: registerPrompt(a.content, a.registers), temperature: 0.3 });
    const j = res.json ?? mock.mockRegister(a.content, a.registers);
    return { items: j.items ?? [], meta: metaOf(res, 'gemini') };
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
      temperature: 0.2,
    });
    const j = res.json as any;
    const action = ['continue', 'inject', 'replan', 'wrap'].includes(j?.action) ? j.action : 'continue';
    return { action, reason: j?.reason ?? 'staying the course', injectKinds: j?.injectKinds, meta: metaOf(res, 'gemini') };
  }

  async simplify(a: Parameters<TutorBrain['simplify']>[0]) {
    const res = await callJSON<any>(this.env, {
      model: this.m('fast'),
      input: `Rewrite this Japanese passage so that a ${a.level} learner reading at 96% known-vocabulary coverage can understand it. Keep the same information and roughly the same length. Only these words may be new to them: up to ${a.allowedNew} items. Prefer simpler syntax over shorter text: split complex clauses, use high-frequency connectives, keep naturalness.\n\nPASSAGE:\n${a.text}\n\nTheir known vocabulary sample: ${a.knownWords.slice(0, 60).join('、')}\n\nReturn JSON {text} only.`,
      temperature: 0.3,
    });
    return { text: (res.json as any)?.text ?? a.text, meta: metaOf(res, 'gemini') };
  }
}

// ------------------------------------------------------------------ mock brain

const mockMeta = (): BrainMeta => ({ kind: 'mock', model: 'scripted', transport: 'mock', ms: 0 });

class MockBrain implements TutorBrain {
  readonly kind = 'mock' as const;
  async planSession(req: PlanRequest): Promise<PlanResult> {
    return { plan: mock.mockPlan(req), meta: mockMeta() };
  }
  async converse(a: Parameters<TutorBrain['converse']>[0]): Promise<TurnResult> {
    const r = mock.mockTurn(a.beat, a.history, a.learnerText, a.model.overall.cefr);
    return { ...r, meta: mockMeta() };
  }
  async markBeat(a: Parameters<TutorBrain['markBeat']>[0]) {
    return { feedback: mock.mockFeedback({ beat: a.beat, transcript: a.transcript, answers: a.answers, level: a.model?.overall?.cefr ?? 'A2' }), meta: mockMeta() };
  }
  async gradeOpen(a: Parameters<TutorBrain['gradeOpen']>[0]) {
    return { feedback: mock.mockGradeOpen(a.text, a.beat, a.level), meta: mockMeta() };
  }
  async debrief(a: Parameters<TutorBrain['debrief']>[0]) {
    return { debrief: mock.mockDebrief(a.plan, a.transcript, a.model.overall.cefr), meta: mockMeta() };
  }
  async synthesizePlacement(a: Parameters<TutorBrain['synthesizePlacement']>[0]) {
    return {
      model: mock.mockPlacement(a.profile, a.evidence),
      notes: ['Scripted placement — heuristic only.'],
      strengths: ['You completed the placement, which is more than most people do.'],
      focusAreas: ['Log a model key for an evidence-based read on particles and register.'],
      firstMonthPlan: ['Weeks 1–2: high-frequency chunks + kana automaticity', 'Weeks 3–4: your first transactional scenarios'],
      caveats: ['No real judgement was applied: this is arithmetic on your raw accuracy.'],
      meta: mockMeta(),
    };
  }
  async gloss(a: Parameters<TutorBrain['gloss']>[0]) { return { ...mock.mockGloss(a.term, a.level), meta: mockMeta() }; }
  async story(a: Parameters<TutorBrain['story']>[0]) { return { ...mock.mockStory(a.episode, a.level, a.dueItems), meta: mockMeta() }; }
  async register(a: Parameters<TutorBrain['register']>[0]) { return { ...mock.mockRegister(a.content, a.registers), meta: mockMeta() }; }
  async adapt(a: Parameters<TutorBrain['adapt']>[0]) {
    const tooHard = a.recent.filter((e) => e.type === 'rating' && e.payload.value === 'too_hard').length;
    const skipped = a.recent.filter((e) => e.type === 'skip').length;
    if (tooHard >= 2) return { action: 'replan' as const, reason: 'you flagged this as too hard twice', meta: mockMeta() };
    if (skipped >= 3) return { action: 'wrap' as const, reason: 'lots of skipping — better to end well than to grind', meta: mockMeta() };
    return { action: 'continue' as const, reason: 'on track', meta: mockMeta() };
  }
  async simplify(a: Parameters<TutorBrain['simplify']>[0]) { return { text: a.text, meta: mockMeta() }; }
}

// ------------------------------------------------------------------ selection + fallback

export function getBrain(env: Env): TutorBrain {
  const mode = env.AI_MODE ?? 'auto';
  if (mode === 'mock') return new MockBrain();
  if (mode === 'gemini' && hasKey(env)) return new GeminiBrain(env);
  if (mode === 'auto' && hasKey(env)) return new GeminiBrain(env);
  return new MockBrain();
}

/** Wrap a brain so a model failure degrades one step instead of breaking the lesson.
 *  The learner sees a small "degraded" note; the session keeps running. */
export function resilient(env: Env, brain: TutorBrain, onDegrade?: (e: Error) => void): TutorBrain {
  if (brain.kind === 'mock') return brain;
  const fallback = new MockBrain();
  const wrap = <K extends keyof TutorBrain>(name: K): TutorBrain[K] => (async (...args: any[]) => {
    try {
      return await (brain[name] as any)(...args);
    } catch (err) {
      onDegrade?.(err as Error);
      const r = await (fallback[name] as any)(...args);
      if (r && typeof r === 'object') {
        if ('meta' in r) (r as any).meta = { ...(r as any).meta, degraded: true, note: `model unavailable (${(err as Error).message.slice(0, 80)})` };
        if ('feedback' in r) (r as any).feedback.degraded = true;
      }
      return r;
    }
  }) as TutorBrain[K];
  return new Proxy(brain, {
    get(target, prop: string) {
      if (prop === 'kind') return target.kind;
      const v = (target as any)[prop];
      if (typeof v === 'function' && prop in fallback) return wrap(prop as keyof TutorBrain);
      return v;
    },
  }) as TutorBrain;
}

// ------------------------------------------------------------------ normalisation

function metaOf(res: ModelResult, kind: 'gemini' | 'mock'): BrainMeta {
  return { kind, model: res.model, transport: res.transport, ms: res.ms };
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
  return {
    headline: j?.headline ?? 'Session complete.',
    highlights: j?.highlights ?? [],
    toKeep: (j?.toKeep ?? []).map((n: any) => ({
      quote: n.quote ?? '', tag: n.tag ?? 'vocab.collocation', issue: '', recast: n.recast ?? '',
      elicit: n.elicit ?? 'どう 言えば いいと 思いますか？', severity: 2 as const,
    })),
    newCards: j?.newCards ?? [],
    canDoAdvanced: j?.canDoAdvanced ?? '',
    nextTeaser: j?.nextTeaser ?? '',
    notebook: j?.notebook ?? '',
  };
}

/** The model returns a narrative model; we merge it into the numeric learner model
 *  the rest of the system reads. Missing fields keep their mock/heuristic values. */
export function normalizeLearnerModel(j: any, profile: Profile, evidence: Record<string, any>): LearnerModel {
  const base = mock.mockPlacement(profile, evidence);
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
  });
}
