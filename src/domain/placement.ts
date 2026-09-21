/**
 * placement.ts — the onboarding instrument.
 *
 * Design position: an app that asks "are you a beginner?" and starts you at lesson 1
 * is wasting the learner's first three weeks. A real tutor spends the first meeting
 * *finding out*, using several independent probes, and then says out loud what they
 * think and how sure they are.
 *
 * So: 11 stages, mixed methods, deliberately redundant, all evidence logged.
 *
 *   1 goal          — why, target, deadline, real situations
 *   2 background    — study history, tests, time in Japan
 *   3 script        — timed kana grid + kanji band sample (measure speed, not knowledge)
 *   4 vocabulary    — adaptive staircase, frequency-banded, ~14 items
 *   5 grammar       — adaptive staircase on particles/conjugation/register
 *   6 reading       — timed passage + comprehension (gives a real WPM number)
 *   7 listening     — 3 clips at increasing speed, gist → detail
 *   8 speaking      — read-aloud (pronunciation), picture/scene description (fluency), 2 follow-ups (interaction)
 *   9 writing       — 2 prompts (transactional + opinion) with rubric marking
 *  10 interview     — 4–5 min adaptive voice conversation, the only probe that measures real interaction
 *  11 style         — correction preferences, interests, pain points, kanji appetite
 *  then reveal       — honest estimate + confidence + first-month plan, editable by the learner
 *
 * Everything except the last stage is skippable ("I'm starting from zero" walks straight
 * to the reveal with a pre-A1 hypothesis and a beginner protocol instead).
 */

import type { CEFR, Profile, Skill } from '../types';
import { VOCAB, GRAMMAR, PLACEMENT_KANA, READING_PASSAGES, LISTENING_CLIPS, SPEAKING_PROBES, WRITING_PROBES } from '../content/seed';
import { cefrIndex, cefrAt, bandFromAccuracy } from './pedagogy';

export type StageId =
  | 'goal' | 'background' | 'script' | 'vocabulary' | 'grammar' | 'reading'
  | 'listening' | 'speaking' | 'writing' | 'interview' | 'style' | 'reveal';

export interface Stage {
  id: StageId;
  title: string;
  titleJA: string;
  blurb: string;
  /** Why we ask — shown to the learner. Transparency measurably improves compliance. */
  because: string;
  minutes: number;
  skippable: boolean;
  /** 'zero' path: absolute beginners can mark this as not applicable. */
  naIfZero?: boolean;
}

export const PLACEMENT_STAGES: Stage[] = [
  { id: 'goal', title: 'Why Japanese?', titleJA: '目標', blurb: 'What you are actually aiming at.', because: 'Everything else is designed backwards from this. A visa deadline, a trip, your partner’s parents and a manga habit need completely different lessons.', minutes: 2, skippable: false },
  { id: 'background', title: 'Your history', titleJA: 'これまで', blurb: 'What study you have already done.', because: 'Textbook learners plateau differently from immersion learners. Knowing which you are saves you months of re-learning things you know.', minutes: 2, skippable: false },
  { id: 'script', title: 'Script check', titleJA: 'かな・漢字', blurb: 'Timed kana grid, then a kanji sample.', because: 'Reading speed is the single best predictor of whether graded material will feel comfortable. We measure it, not your opinion of it.', minutes: 3, skippable: false, naIfZero: true },
  { id: 'vocabulary', title: 'Vocabulary staircase', titleJA: '語彙', blurb: 'About 14 items, getting harder until you miss.', because: 'Gives us a real vocabulary size estimate — which decides how dense your reading passages can be.', minutes: 3, skippable: false, naIfZero: true },
  { id: 'grammar', title: 'Patterns', titleJA: '文法', blurb: 'Particles, conjugation, register.', because: 'Japanese grammar fails in specific, known places: particles, transitivity, register. We map yours so lessons target them.', minutes: 3, skippable: false, naIfZero: true },
  { id: 'reading', title: 'Reading speed', titleJA: '読解', blurb: 'One short passage, timed.', because: 'Words per minute plus comprehension accuracy tells us your reading level far more precisely than a self-rating.', minutes: 4, skippable: true, naIfZero: true },
  { id: 'listening', title: 'Listening', titleJA: '聴解', blurb: 'Three clips, increasing speed.', because: 'Listening comprehension lags reading for almost every self-taught learner. We need to know your gap.', minutes: 4, skippable: true, naIfZero: true },
  { id: 'speaking', title: 'Speaking', titleJA: '話す', blurb: 'Read three lines, then talk for a minute.', because: 'The only honest measure of speaking is speaking. You will get a pronunciation read and a fluency read.', minutes: 5, skippable: true, naIfZero: false },
  { id: 'writing', title: 'Writing', titleJA: '書く', blurb: 'Two short pieces.', because: 'Writing shows us what you can assemble without a listener helping you along — it is usually lower than your speaking, and that is normal.', minutes: 5, skippable: true, naIfZero: true },
  { id: 'interview', title: 'Let’s just talk', titleJA: '面接', blurb: '4 minutes of conversation, in Japanese.', because: 'This is the part no quiz can measure: whether you can steer a real conversation, repair it when it breaks, and keep someone interested.', minutes: 5, skippable: true },
  { id: 'style', title: 'How you want to be taught', titleJA: 'スタイル', blurb: 'Corrections, interests, pet peeves.', because: 'Corrections during the conversation and corrections afterwards produce similar test results — but very different feelings. You should choose.', minutes: 2, skippable: false },
  { id: 'reveal', title: 'Here’s what I think', titleJA: '結果', blurb: 'Your starting hypothesis.', because: 'You will be shown a level, the evidence for it, and how sure I am. Correct me if I am wrong — you know things about your Japanese that I cannot see.', minutes: 2, skippable: false },
];

// ------------------------------------------------------------------ item bank

export interface BankItem {
  id: string;
  section: 'vocabulary' | 'grammar' | 'reading' | 'listening';
  level: CEFR;
  prompt: string;
  options?: string[];
  answer: string;
  explanation: string;
  tags: string[];
  /** Opt-in hint (e.g. the reading of a kanji word), revealed only if the learner asks. */
  hint?: string;
  /** For listening: what to speak. For reading: the passage id. */
  audio?: string;
}

const LEVELS: CEFR[] = ['A1', 'A1+', 'A2.1', 'A2', 'A2+', 'B1', 'B1+', 'B2'];

/**
 * Distractors that actually test the word.
 *
 * The naive version took the next three entries at the same level, which meant the
 * same three wrong options recurred on every item — a learner could eliminate them by
 * pattern rather than by knowing the word. These are drawn from words that share a
 * part of speech or a topic tag, falling back to the same level, then anything.
 */
function distractorsFor(v: (typeof VOCAB)[number]): string[] {
  const others = VOCAB.filter((x) => x.id !== v.id && x.en !== v.en);
  const byTag = others.filter((x) => (x.tags ?? []).some((t) => (v.tags ?? []).includes(t)));
  const byPos = others.filter((x) => x.pos === v.pos);
  const byLevel = others.filter((x) => x.level === v.level);
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const x of shuffle([...byTag, ...shuffle(byPos), ...shuffle(byLevel), ...shuffle(others)])) {
    if (seen.has(x.en)) continue;
    seen.add(x.en);
    pool.push(x.en);
    if (pool.length === 3) break;
  }
  return pool;
}

/** Bank for the adaptive staircase. When a model key is present the brain can extend
 *  this with freshly generated items at the learner's frontier; the seed bank alone is
 *  enough for an honest A1→B2 estimate. */
export function buildBank(): BankItem[] {
  const vocabItems: BankItem[] = VOCAB.map((v) => {
    return {
      id: `bank.v.${v.id}`, section: 'vocabulary' as const, level: v.level,
      // The reading is a separate, opt-in hint rather than a stub letter. A stub like
      // "(T…)" narrows a four-way choice without teaching anything; asking for the
      // reading is honest evidence, the same way "I don't know" is.
      prompt: `「${v.surface}」の 意味は？`,
      hint: `${v.reading}`,
      options: shuffle([v.en, ...distractorsFor(v)]),
      answer: v.en,
      explanation: `${v.surface}（${v.reading}）= ${v.en}. ${v.example}`,
      tags: ['vocab', ...v.tags],
    };
  });

  const grammarItems: BankItem[] = GRAMMAR.map((g) => {
    const blank = g.example.replace(g.example.slice(0, 0), '');
    return {
      id: `bank.g.${g.id}`, section: 'grammar' as const, level: g.level,
      prompt: `${g.pattern} — ${g.en}\nどの 文が 自然ですか？`,
      options: shuffle([g.example, `${g.example.replace(/。/g, '')}だです。`, `私が${g.example}`, `${g.example}でしたら`]),
      answer: g.example,
      explanation: `${g.pattern}: ${g.en}. Frequent error: ${g.commonError}`,
      tags: ['grammar', g.errorTag],
    };
  });

  const readingItems: BankItem[] = READING_PASSAGES.flatMap((p) => p.questions.map((q, i) => ({
    id: `bank.r.${p.id}.${i}`, section: 'reading' as const, level: p.level,
    prompt: q.prompt, options: q.options, answer: q.answer, explanation: q.explanation, tags: ['reading'],
  })));

  const listeningItems: BankItem[] = LISTENING_CLIPS.flatMap((c) => c.questions.map((q, i) => ({
    id: `bank.l.${c.id}.${i}`, section: 'listening' as const, level: c.level,
    prompt: q.prompt, options: q.options, answer: q.answer, explanation: q.explanation, tags: ['listening'], audio: c.script,
  })));

  return [...vocabItems, ...grammarItems, ...readingItems, ...listeningItems];
}

/** Staircase state — a lazy man's CAT that is honest and hard to game. */
export interface StairStep {
  level: CEFR;
  correct: boolean;
  /** Learner pressed "I don't know" — stronger evidence than a wrong guess, and it is
   *  never allowed to climb the staircase. */
  unsure?: boolean;
  /** Chance of a blind guess on this item (1 / option count), used to correct accuracy. */
  chance?: number;
}

export interface StairState {
  level: CEFR;
  served: string[];
  correct: number;
  total: number;
  unsure: number;
  /** Path of steps so we can report the frontier rather than an average. */
  path: StairStep[];
}

export function stairStart(): StairState {
  return { level: 'A2.1', served: [], correct: 0, total: 0, unsure: 0, path: [] };
}

export function stairNext(state: StairState, section: 'vocabulary' | 'grammar'): BankItem | undefined {
  const bank = buildBank().filter((b) => b.section === section && !state.served.includes(b.id));
  const sameLevel = bank.filter((b) => b.level === state.level);
  return sameLevel[Math.floor(Math.random() * sameLevel.length)] ?? bank[0];
}

export function stairUpdate(state: StairState, item: BankItem, correct: boolean, unsure = false): StairState {
  const chance = item.options?.length ? 1 / item.options.length : 0;
  const path: StairStep[] = [...state.path, { level: item.level, correct, unsure, chance }];
  const i = cefrIndex(item.level);
  // Climb needs two clean answers in a row at this level. Dropping is asymmetric:
  // "I don't know" is a deliberate admission and drops on its own, while a wrong
  // answer might be a slip or a bad guess, so it takes two.
  const last2 = path.slice(-2);
  const twoRight = last2.length === 2 && last2.every((p) => p.correct && !p.unsure);
  const twoWrong = last2.length === 2 && last2.every((p) => !p.correct);
  const next = twoRight ? i + 1 : (unsure || twoWrong) ? i - 1 : i;
  return {
    level: cefrAt(Math.max(0, Math.min(LEVELS.length + 1, next))),
    served: [...state.served, item.id],
    correct: state.correct + (correct && !unsure ? 1 : 0),
    total: state.total + 1,
    unsure: state.unsure + (unsure ? 1 : 0),
    path,
  };
}

/**
 * Estimate the frontier: the highest level they were reliably right at, corrected for
 * guessing. On a four-option item, one right answer in four is the floor you would get
 * by answering at random, so that much of the accuracy is discounted out:
 *
 *   adjusted = (correct − n·chance) / (n − n·chance)
 *
 * "I don't know" answers are excluded from the denominator entirely rather than
 * counted as wrong: not knowing is not the same as answering incorrectly, and
 * pretending otherwise would push a cautious learner's estimate down for honesty.
 */
export function stairEstimate(state: StairState): {
  cefr: CEFR; accuracy: number; adjusted: number; n: number; unsure: number; guessFloor: number;
} {
  const byLevel = new Map<number, { c: number; n: number; chance: number; unsure: number }>();
  let attempts = 0, right = 0, chanceSum = 0, unsureTotal = 0;
  for (const p of state.path) {
    const idx = cefrIndex(p.level);
    const e = byLevel.get(idx) ?? { c: 0, n: 0, chance: 0, unsure: 0 };
    if (p.unsure) {
      e.unsure += 1; unsureTotal += 1;
    } else {
      e.n += 1;
      e.chance += p.chance ?? 0.25;
      attempts += 1;
      chanceSum += p.chance ?? 0.25;
      if (p.correct) { e.c += 1; right += 1; }
    }
    byLevel.set(idx, e);
  }
  const adjust = (c: number, n: number, chance: number) => {
    if (!n) return 0;
    const floor = chance;
    return floor >= 1 ? 0 : Math.max(0, Math.min(1, (c / n - floor) / (1 - floor)));
  };
  let frontier = 0;
  for (const [idx, e] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    const avgChance = e.n ? e.chance / e.n : 0.25;
    // One lucky answer should not set the frontier; require two attempts, or a clean
    // single answer when the learner has already shown they belong at this level.
    if (e.n >= 2 && adjust(e.c, e.n, avgChance) >= 0.6) frontier = idx;
    else if (e.n === 1 && e.c === 1 && idx <= frontier) frontier = Math.max(frontier, idx);
  }
  return {
    cefr: cefrAt(frontier),
    accuracy: attempts ? right / attempts : 0,
    adjusted: adjust(right, attempts, attempts ? chanceSum / attempts : 0.25),
    n: attempts,
    unsure: unsureTotal,
    guessFloor: attempts ? Math.round((chanceSum / attempts) * 100) / 100 : 0.25,
  };
}

/** Anything faster than this was filled by a script, a password manager or a very
 *  lucky paste. Trusting it would hand out automaticity credit for nothing. */
const MIN_PLAUSIBLE_MS = 120;

export function kanaScore(answers: { kana: string; given: string; correct: boolean; ms: number }[]) {
  const plausible = answers.filter((a) => Number.isFinite(a.ms) && a.ms >= MIN_PLAUSIBLE_MS);
  const correct = answers.filter((a) => a.correct).length;
  const acc = answers.length ? correct / answers.length : 0;

  // Speed only counts for kana the learner actually got right. Averaging in the
  // latencies of wrong answers rewarded fast guessing: an 8%-accurate run typed at
  // speed used to score 0.28 on automaticity, which is the opposite of the truth.
  const right = plausible.filter((a) => a.correct).map((a) => a.ms);
  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const medianMs = median(right);
  const medianAllMs = median(plausible.map((a) => a.ms));

  // Automaticity threshold: knowing a kana is not enough, you need it under ~700ms.
  const speed = medianMs === null ? 0 : Math.max(0, Math.min(1, (2000 - medianMs) / 1500));

  return {
    accuracy: acc,
    medianMs: medianMs ?? medianAllMs ?? 3000,
    /** How much of the speed evidence we actually kept. */
    timedItems: right.length,
    ignoredItems: answers.length - plausible.length,
    score: Math.round(acc * (0.65 + 0.35 * speed) * 100) / 100,
  };
}

export function readingScore(passageChars: number, seconds: number, correct: number, total: number) {
  const minutes = Math.max(0.2, seconds / 60);
  const wpm = Math.round(passageChars / minutes);
  const comprehension = total ? correct / total : 0;
  return { wpm, comprehension, effectiveWpm: Math.round(wpm * comprehension) };
}

/** Which skipped probes weaken which skill estimate — surfaced in the reveal so the
 *  learner can decide whether to go back and fill a gap. */
export const PROBE_TO_SKILL: Record<string, Skill[]> = {
  script: ['reading', 'kanji'],
  vocabulary: ['vocabulary'],
  grammar: ['grammar'],
  reading: ['reading'],
  listening: ['listening'],
  speaking: ['speaking'],
  writing: ['writing'],
  interview: ['speaking', 'interaction', 'listening'],
};

export function placementEvidenceSummary(ev: Record<string, any>, skipped: StageId[]): string[] {
  const notes: string[] = [];
  if (skipped.length) {
    const affected = new Set(skipped.flatMap((s) => PROBE_TO_SKILL[s] ?? []));
    if (affected.size) notes.push(`Skipped probes mean lower confidence in: ${[...affected].join(', ')}.`);
  }
  if (ev.readingWPM) notes.push(`Reading at ${ev.readingWPM} wpm with ${Math.round((ev.readingComprehension ?? 0) * 100)}% comprehension.`);
  if (ev.kanaScore !== undefined) {
    const timed = ev.kanaTimedItems ?? 0;
    if (timed >= 3) {
      notes.push(`Kana accuracy ${Math.round(ev.kanaAccuracy * 100)}%, median ${ev.kanaMedianMs}ms on the ones you got right${ev.kanaMedianMs > 900 ? ' — still decoding, not yet reading' : ''}.`);
    } else {
      notes.push(`Kana accuracy ${Math.round(ev.kanaAccuracy * 100)}%, but there was not enough usable timing evidence to say anything about automaticity — that part stays a question.`);
    }
  }
  if (ev.quizAccuracy !== undefined) notes.push(`Adaptive item accuracy ${Math.round(ev.quizAccuracy * 100)}% across ${ev.quizCount ?? '?'} items — chance-corrected for 4-option guessing.`);
  return notes;
}

// ------------------------------------------------------------------ default profile

export function emptyProfile(id: string, l1 = 'en'): Profile {
  return {
    id, createdAt: Date.now(), updatedAt: Date.now(), l1,
    goals: { primary: 'fun', detail: '', targetLevel: 'A2', targetJLPT: 'none', realSituations: [] },
    constraints: { minutesPerDay: 20, sessionLength: 20, daysPerWeek: 4, modePreference: 'either', hasMic: true, device: 'desktop', quietEnvironments: false },
    style: {
      correctionTiming: 'after', correctionStyle: 'gentle', l1Support: 'explanations', romaji: 'on_demand',
      kanjiAppetite: 'steady', pitchAccentInterest: false, interests: [], avoidTopics: [], painPoints: [], motivationNote: '',
    },
    background: { yearsStudying: 0, formalClasses: false, inJapanMonths: 0, priorTests: [], selfRating: {} },
  };
}

/** Absolute-beginner fast path: skip the probes that assume prior knowledge. */
export function zeroPathStages(): StageId[] {
  return ['goal', 'background', 'script', 'vocabulary', 'speaking', 'style', 'reveal'];
}

export function probesFor(stage: StageId) {
  switch (stage) {
    case 'script': return { kana: PLACEMENT_KANA, kanji: VOCAB.filter((v) => ['A1', 'A1+'].includes(v.level)).slice(0, 6) };
    case 'speaking': return { probes: SPEAKING_PROBES };
    case 'writing': return { probes: WRITING_PROBES };
    case 'reading': return { passages: READING_PASSAGES };
    case 'listening': return { clips: LISTENING_CLIPS };
    default: return {};
  }
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/** Turn raw stage responses into the evidence object the synthesis prompt consumes. */
export function collectEvidence(responses: Record<string, any>): Record<string, any> {
  const vocab = stairEstimate(responses.vocabulary?.state ?? stairStart());
  const gram = stairEstimate(responses.grammar?.state ?? stairStart());
  const reading = responses.reading ? readingScore(responses.reading.chars ?? 0, responses.reading.seconds ?? 60, responses.reading.correct ?? 0, responses.reading.total ?? 1) : null;
  const kana = responses.script?.kana ? kanaScore(responses.script.kana) : null;
  const listening = responses.listening ? (responses.listening.correct ?? 0) / Math.max(1, responses.listening.total ?? 1) : null;
  const speaking = responses.speaking ? (responses.speaking.meanScore ?? 0.5) : null;
  const writing = responses.writing ? (responses.writing.score ?? 0.5) : null;
  const interview = responses.interview ? (responses.interview.score ?? 0.5) : null;

  const quizes = [vocab.n, gram.n].reduce((a, b) => a + b, 0);
  const right = [vocab.accuracy * vocab.n, gram.accuracy * gram.n].reduce((a, b) => a + b, 0);

  return {
    vocabBand: vocab.cefr, vocabAccuracy: vocab.accuracy, vocabItems: vocab.n,
    grammarBand: gram.cefr, grammarAccuracy: gram.accuracy, grammarItems: gram.n,
    quizAccuracy: quizes ? right / quizes : undefined, quizCount: quizes,
    kanaAccuracy: kana?.accuracy, kanaMedianMs: kana?.medianMs, kanaScore: kana?.score,
    kanaTimedItems: kana?.timedItems,
    readingWPM: reading?.wpm, readingComprehension: reading?.comprehension, effectiveWpm: reading?.effectiveWpm,
    listeningScore: listening ?? undefined,
    speakingScore: speaking ?? undefined,
    speakingTurns: (responses.speaking?.turns ?? []).slice(0, 6).map((t: any) => t.text),
    interviewTurns: (responses.interview?.turns ?? []).slice(0, 6).map((t: any) => t.text),
    writingSamples: (responses.writing?.samples ?? []).slice(0, 2).map((t: any) => t.text),
    writingScore: writing ?? undefined,
    interviewScore: interview ?? undefined,
    skipped: responses.__skipped ?? [],
  };
}
